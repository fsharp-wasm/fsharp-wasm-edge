// The core that runs a WebAssembly GC module (compiled by fsharp-wasm, built on FSharp.Wasm.Server) as an HTTP handler, on any
// platform that speaks web-standard Request and Response: Cloudflare Workers, Vercel, Netlify, Deno, Bun, Node.
//
//   const server = createServer({ module, hostName: "deno", store });      // module: a WebAssembly.Module or the bytes
//   const response = await server.fetch(request);                          // one request at a time, in order
//
// What a module may do is what its imports say (FSharp.Wasm.Server.HostImports): read the request, write the response, read and
// write a small key-value store, ask where it runs.  It is synchronous — it cannot wait for a network call — which is why the
// core reads the body and loads the store before the call and flushes the store after it.
//
// Strings cross the boundary in one of two ways, chosen when the module is compiled (WASMGC_STRING_ABI):
//   builtins  the JS String Builtins (`wasm:js-string`): JS strings, no glue; the engine must compile the module with
//             { builtins: ["js-string"] } (V8 13+: Node 24, Deno 2.1).  A WebAssembly.Module passed in must have been compiled with
//             them; bytes are compiled here that way.
//   exports   an opaque reference to the module's string, read and built through the exports __str_len / __str_at / __str_new /
//             __str_set: any engine with WebAssembly GC, including where modules are precompiled without builtins (Cloudflare
//             Workers, Vercel Edge).  The core tells them apart by the imports of the module.

const BUILTINS = { builtins: ["js-string"] };
const MAX_BODY = 1 << 20;
// A request that lost its commit against another writer runs again over what the winner wrote.  Each attempt loses only to a writer that won, so the instances make progress together;
// the wait is random so that they do not collide again in step.  Twelve attempts hold a burst of that many writers on one state; beyond that the answer is 503 and a retry.
const ATTEMPTS = 12;
const backoff = (attempt) => new Promise((resolve) => setTimeout(resolve, Math.random() * 4 * 2 ** Math.min(attempt, 6)));

/** True when this engine compiles modules that import `wasm:js-string` (V8 13+: Node 24, Deno 2.1, Chrome 130). */
export function supportsJsStringBuiltins() {
  try {
    // (module (import "wasm:js-string" "length" (func (param externref) (result i32))))
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 111, 1, 127, 2, 25, 1, 14, 119, 97, 115, 109, 58, 106, 115, 45, 115, 116, 114, 105, 110, 103, 6, 108, 101, 110, 103, 116, 104, 0, 0]);
    new WebAssembly.Module(bytes, BUILTINS);
    return true;
  } catch { return false; }
}

const usesBuiltins = (module) => WebAssembly.Module.imports(module).some((i) => i.module === "wasm:js-string");

// a module of the Exports ABI needs no builtins: compile it plainly (a WebAssembly.Module is taken as it is)
// a WebAssembly.Module made in another realm (a sandbox) is not `instanceof` this one: ask what it is
const isModule = (x) => x instanceof WebAssembly.Module || Object.prototype.toString.call(x) === "[object WebAssembly.Module]";

/** The module of `source` (a WebAssembly.Module or its bytes), compiled the way the engine needs: compile once, give the result to as many servers as there are states. */
export const compileModule = (source) => {
  if (isModule(source)) return source;
  const plain = new WebAssembly.Module(source);
  return usesBuiltins(plain) ? new WebAssembly.Module(source, BUILTINS) : plain;
};

// which host functions take strings, and which return one (the Exports ABI converts exactly these)
const STRING_ARGS = { resHeader: [0, 1], resText: [0], storeGet: [0], storePut: [0, 1], storeDelete: [0], log: [0] };
const STRING_RESULTS = new Set(["reqMethod", "reqPath", "reqQuery", "reqHeaders", "reqBody", "storeGet", "hostName"]);

/** The path of a request below `basePath` ("" = at the root; "/fn" = under /fn), or null when it is not below it. */
export function pathBelow(basePath, request) {
  const path = new URL(request.url).pathname;
  if (!basePath) return path;
  if (path === basePath) return "/";
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : null;
}

const decoded = new WeakMap();          // an asset's bytes, decoded once

/**
 * The response to a GET for one of `assets` (a map path -> asset), or null.  An asset is one of
 *   { type, body }      text
 *   { type, base64 }    bytes (a WebAssembly module): carried as text so that the table is one JavaScript module on every platform
 *   { redirect }        a redirect, to an address relative to the one asked for ("canvas/" for "/canvas"), so that it holds below any base path
 */
export function serveAsset(assets, request, basePath = "") {
  const path = request.method === "GET" ? pathBelow(basePath, request) : null;
  const asset = path === null ? undefined : assets[path];
  if (!asset) return null;
  if (asset.redirect) return new Response(null, { status: 308, headers: { location: asset.redirect } });
  let body = asset.body;
  if (asset.base64 !== undefined) {
    if (!decoded.has(asset)) decoded.set(asset, Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0)));
    body = decoded.get(asset);
  }
  return new Response(body, { headers: { "content-type": asset.type, "cache-control": "no-cache" } });
}

/**
 * @param {object}  options
 * @param {WebAssembly.Module | BufferSource} options.module  the compiled module (or its bytes)
 * @param {string}  options.hostName   what the module sees as `hostName()`: "node", "deno", "cloudflare-workers", …
 * @param {object}  options.store      a store of stores.js; default memory.  A store whose `flush` says `false` lost against another writer: the request runs again
 * @param {string}  [options.basePath] the module is mounted below this path ("/fn"); the module and the assets see the rest
 * @param {boolean} [options.reload]   reload the state from the store before every request (a stateless platform whose instances share it)
 * @param {Record<string, {type: string, body: string}>} [options.assets]  files served before the module is asked (GET only)
 */
export function createServer({ module, hostName, store, reload = false, assets = {}, basePath = "" }) {
  const compiled = compileModule(module);
  let current = null;
  const log = (m) => console.log(`[${hostName}] ${m}`);
  const stringStore = store;

  const host = {
    reqMethod: () => current.method,
    reqPath: () => current.path,
    reqQuery: () => current.query,
    reqHeaders: () => current.headers,
    reqBody: () => current.body,
    resStatus: (code) => { current.status = code; },
    resHeader: (name, value) => { current.responseHeaders.push([name, value]); },
    resText: (text) => { current.payload = text; },
    resBytesBegin: (length) => { current.bytes = new Uint8Array(length); current.position = 0; },
    resByte: (b) => { current.bytes[current.position++] = b; },
    resBytesEnd: () => { current.payload = current.bytes; },
    storeGet: (key) => stringStore.get(key) ?? "",
    storePut: (key, value) => stringStore.put(key, value),
    storeDelete: (key) => stringStore.delete(key),
    hostName: () => hostName,
    nowMs: () => Date.now(),
    log,
    // the module asks to be called again (its `idle` export) once the response has gone out: work that need not make a request wait
    requestIdle: () => { current.idle = true; },
  };

  // the Exports ABI: strings are the module's own, read and built through its exports (known once it is instantiated)
  const exportsAbi = !usesBuiltins(compiled);
  let ex = null;
  let bulk = false;
  // A module compiled after 2026-11-22 also exports a linear memory and three functions that move a whole string through it (`__str_reserve`, `__str_to_mem`, `__str_from_mem`,
  // UTF-16 code units from address 0): two calls and one copy instead of a call per character, which was 42.5 % of a request that answered 218 000 characters.  An older module,
  // or a string the memory cannot hold, goes through the per-character exports.
  const readPerChar = (ref) => {
    const n = ex.__str_len(ref);
    let out = "";
    for (let i = 0; i < n; i += 4096) {
      const codes = [];
      for (let j = i; j < Math.min(n, i + 4096); j++) codes.push(ex.__str_at(ref, j));
      out += String.fromCharCode(...codes);
    }
    return out;
  };
  const makePerChar = (text) => {
    const ref = ex.__str_new(text.length);
    for (let i = 0; i < text.length; i++) ex.__str_set(ref, i, text.charCodeAt(i));
    return ref;
  };
  const readString = (ref) => {
    if (bulk) {
      const n = ex.__str_to_mem(ref);
      if (n >= 0) {
        const units = new Uint16Array(ex.memory.buffer, 0, n);          // taken after the call: it may have grown the memory
        let out = "";
        for (let i = 0; i < n; i += 8192) out += String.fromCharCode.apply(null, units.subarray(i, i + 8192));
        return out;
      }
    }
    return readPerChar(ref);
  };
  const makeString = (text) => {
    if (bulk && ex.__str_reserve(text.length) === 0) {
      const units = new Uint16Array(ex.memory.buffer, 0, text.length);
      for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
      return ex.__str_from_mem(text.length);
    }
    return makePerChar(text);
  };
  const bridge = (name, fn) => {
    if (!exportsAbi) return fn;
    const stringArgs = STRING_ARGS[name] ?? [];
    const returnsString = STRING_RESULTS.has(name);
    if (!stringArgs.length && !returnsString) return fn;
    return (...args) => {
      const result = fn(...args.map((a, i) => (stringArgs.includes(i) ? readString(a) : a)));
      return returnsString ? makeString(result) : result;
    };
  };

  // the imports a module declares, resolved by name; anything else is an error that says what is missing
  const imports = {};
  for (const { module: ns, name, kind } of WebAssembly.Module.imports(compiled)) {
    if (ns === "wasm:js-string") continue;                      // provided by the engine, through the compile option
    if (kind !== "function") throw new Error(`unsupported import ${ns}.${name} (${kind})`);
    const fn = ns === "runtime/server.js" ? host[name] : undefined;
    if (!fn) throw new Error(`the module imports ${ns}.${name}, which this host does not provide`);
    (imports[ns] ??= {})[name] = bridge(name, fn);
  }

  let instance = null;
  const ensureInstance = () => {
    if (!instance) {
      instance = new WebAssembly.Instance(compiled, imports);
      ex = instance.exports;
      bulk = typeof ex.__str_to_mem === "function" && typeof ex.__str_from_mem === "function" && typeof ex.__str_reserve === "function" && ex.memory instanceof WebAssembly.Memory;
      if (exportsAbi && !(ex.__str_len && ex.__str_new)) throw new Error("the module has neither the JS String Builtins nor the string accessor exports");
    }
    return instance;
  };

  // requests run one after the other: the module has one state and the imports read `current`
  let queue = Promise.resolve();
  const serialized = (task) => (queue = queue.then(task, task));

  // `idle` runs as a task of its own in the same queue as the requests (the module has one state), after the response and one turn of the event loop, so the response is written first.
  // A module that has no `idle` export is never asked; one that is asked and cannot be reached just does not get its call (it asks again with a later request).
  let idleQueued = false;
  const scheduleIdle = () => {
    if (idleQueued) return;
    idleQueued = true;
    serialized(async () => {
      idleQueued = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        // a call that lost to another writer is dropped after its attempts: the module asks again with the next request that finds the work due
        await transact((exports) => exports.idle?.());
      } catch (e) {
        log(`idle failed: ${e?.message ?? e}`);
      }
    });
  };

  /**
   * `task(exports)` over the loaded state, and the state it changed written; its result, or `null` when every attempt lost its write.  A lost attempt leaves the module
   * with a state that is behind (it keeps its own copy of what it read): `reset` makes it read again, from the store, which has loaded what the winner wrote.
   */
  async function transact(task) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      await stringStore.load(reload);
      const exports = ensureInstance().exports;
      if (reload || attempt > 0) exports.reset?.();
      const result = task(exports);
      if ((await stringStore.flush()) !== false) return { result };
      await backoff(attempt);
    }
    return null;
  }

  const refused = (status, text) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1" } });

  async function handle(request, path) {
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const text = hasBody ? await request.text() : "";
    if (text.length > MAX_BODY) return new Response("payload too large", { status: 413 });

    const run = (exports) => {
      current = {
        method: request.method, path, query: url.search.replace(/^\?/, ""),
        headers: [...request.headers].flat().join("\n"), body: text,
        status: 200, responseHeaders: [], payload: "", bytes: null, position: 0, idle: false,
      };
      try {
        exports.handle();
        return current;
      } finally {
        current = null;
      }
    };
    let outcome;
    try {
      outcome = await transact(run);
    } catch (e) {
      if (!e?.unavailable) throw e;
      log(e.message);
      return refused(503, e.message);
    }
    if (!outcome) return refused(503, "the state is being changed by other requests faster than this one could follow: try again");
    const done = outcome.result;
    if (done.idle) scheduleIdle();
    const empty = done.status === 204 || done.status === 304 || request.method === "HEAD";
    const response = new Response(empty ? null : done.payload, { status: done.status });
    // a name once, except those that may repeat
    for (const [name, value] of done.responseHeaders) (name.toLowerCase() === "set-cookie" ? response.headers.append : response.headers.set).call(response.headers, name, value);
    return response;
  }

  return {
    /** The response to a request: a file of `assets`, or what the module makes of it. */
    fetch(request) {
      const path = pathBelow(basePath, request);
      if (path === null) return Promise.resolve(new Response("not found", { status: 404 }));
      const asset = serveAsset(assets, request, basePath);
      return asset ? Promise.resolve(asset) : serialized(() => handle(request, path));
    },
    /** Resolves when every task that was queued has run, the `idle` calls the module asked for included: a platform that ends an instance after the response (`waitUntil`) waits for it. */
    async settled() {
      let tail;
      do { tail = queue; await tail; } while (tail !== queue);
    },
    /** Free-form facts for diagnostics. */
    describe: () => ({ hostName, stringAbi: exportsAbi ? "exports" : "builtins", engineBuiltins: supportsJsStringBuiltins() }),
  };
}
