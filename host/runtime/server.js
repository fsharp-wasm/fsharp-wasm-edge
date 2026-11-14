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

const toModule = (source) => {
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

/** The response to a GET for one of `assets` (a map path -> { type, body }), or null. */
export function serveAsset(assets, request, basePath = "") {
  const path = request.method === "GET" ? pathBelow(basePath, request) : null;
  const asset = path === null ? undefined : assets[path];
  return asset ? new Response(asset.body, { headers: { "content-type": asset.type, "cache-control": "no-cache" } }) : null;
}

/**
 * @param {object}  options
 * @param {WebAssembly.Module | BufferSource} options.module  the compiled module (or its bytes)
 * @param {string}  options.hostName   what the module sees as `hostName()`: "node", "deno", "cloudflare-workers", …
 * @param {object}  options.store      a store of stores.js; default memory
 * @param {string}  [options.basePath] the module is mounted below this path ("/fn"); the module and the assets see the rest
 * @param {boolean} [options.reload]   reload the state from the store before every request (a stateless platform whose instances share it)
 * @param {Record<string, {type: string, body: string}>} [options.assets]  files served before the module is asked (GET only)
 */
export function createServer({ module, hostName, store, reload = false, assets = {}, basePath = "" }) {
  const compiled = toModule(module);
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
  };

  // the Exports ABI: strings are the module's own, read and built through its exports (known once it is instantiated)
  const exportsAbi = !usesBuiltins(compiled);
  let ex = null;
  const readString = (ref) => {
    const n = ex.__str_len(ref);
    let out = "";
    for (let i = 0; i < n; i += 4096) {
      const codes = [];
      for (let j = i; j < Math.min(n, i + 4096); j++) codes.push(ex.__str_at(ref, j));
      out += String.fromCharCode(...codes);
    }
    return out;
  };
  const makeString = (text) => {
    const ref = ex.__str_new(text.length);
    for (let i = 0; i < text.length; i++) ex.__str_set(ref, i, text.charCodeAt(i));
    return ref;
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
      if (exportsAbi && !(ex.__str_len && ex.__str_new)) throw new Error("the module has neither the JS String Builtins nor the string accessor exports");
    }
    return instance;
  };

  // requests run one after the other: the module has one state and the imports read `current`
  let queue = Promise.resolve();
  const serialized = (task) => (queue = queue.then(task, task));

  async function handle(request, path) {
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const text = hasBody ? await request.text() : "";
    if (text.length > MAX_BODY) return new Response("payload too large", { status: 413 });

    await stringStore.load(reload);
    const exports = ensureInstance().exports;
    if (reload) exports.reset?.();

    current = {
      method: request.method, path, query: url.search.replace(/^\?/, ""),
      headers: [...request.headers].flat().join("\n"), body: text,
      status: 200, responseHeaders: [], payload: "", bytes: null, position: 0,
    };
    try {
      exports.handle();
    } finally {
      var done = current;
      current = null;
    }
    await stringStore.flush();
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
    /** Free-form facts for diagnostics. */
    describe: () => ({ hostName, stringAbi: exportsAbi ? "exports" : "builtins", engineBuiltins: supportsJsStringBuiltins() }),
  };
}
