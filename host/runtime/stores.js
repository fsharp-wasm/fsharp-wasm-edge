// The stores a module persists its state in.  A module is synchronous and a platform's storage is not, so every store is a cache:
// `load()` reads what the module may ask for into memory, `get` / `put` / `delete` work on the cache, `flush()` writes what changed.
// The core calls load() before and flush() after each request.  One implementation does the caching; a platform supplies the two
// functions that talk to its storage.
//
//   cachedStore({ read, write })   read(): Promise<Record<string, string>>   write(puts, deletes): Promise<void>
//
// Instances that share one storage (Vercel, Netlify: every request may land on another instance) cannot cache: they read the version
// of the state, and write only if nobody wrote since.
//
//   versionedStore(shared)         shared.read(seen): Promise<{ version, entries? }>   shared.commit(expected, puts, deletes): Promise<{ ok, version }>
//
// flush() says `false` when its write lost against another writer: nothing was written, the store holds what the winner wrote after the
// next load(), and the core runs the request again over that.

/** `items` in groups of at most `size`: the storages below take a limited number of keys per call (a Durable Object 128, a Deno KV atomic operation 1 000 mutations). */
const groups = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** A store over a platform's storage; `reloadEachRequest` makes load() read again (a stateless platform, instances that share the storage). */
export function cachedStore({ read, write }) {
  let cache = new Map();
  let loaded = false;
  let puts = new Map();
  let deletes = new Set();
  return {
    async load(force = false) {
      if (loaded && !force) return;
      cache = new Map(Object.entries(await read()));
      puts = new Map();
      deletes = new Set();
      loaded = true;
    },
    get: (key) => cache.get(key),
    put(key, value) { cache.set(key, value); puts.set(key, value); deletes.delete(key); },
    delete(key) { cache.delete(key); puts.delete(key); deletes.add(key); },
    async flush() {
      if (puts.size === 0 && deletes.size === 0) return true;
      const p = Object.fromEntries(puts), d = [...deletes];
      puts = new Map();
      deletes = new Set();
      await write(p, d);
      return true;
    },
  };
}

/** Memory only: state lives as long as the instance (every platform; a serverless instance forgets between cold starts). */
export const memoryStore = () => cachedStore({ read: async () => ({}), write: async () => {} });

/**
 * A journal file (Node, Bun): every flush appends one line with what it changed (`{"p": {key: value}, "d": [key]}`), so a request costs what it wrote and not the size of the state.
 * The file is read whole on load, a line after another, the last one standing; a line that does not parse (a write that was cut short) ends the journal there. It is rewritten as one line,
 * atomically, when it has grown past twice its live content. A file of the earlier format, one JSON object of the keys, is read as such.
 */
export function fileStore(path, fs) {
  let live = new Map();
  let lines = 0;
  const compactLine = () => JSON.stringify({ p: Object.fromEntries(live) }) + "\n";
  return cachedStore({
    read: async () => {
      let text = "";
      try { text = await fs.readFile(path, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      live = new Map();
      lines = 0;
      for (const line of text.split("\n")) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { break; }
        if (record && (typeof record.p === "object" || Array.isArray(record.d))) {
          for (const [k, v] of Object.entries(record.p ?? {})) live.set(k, v);
          for (const k of record.d ?? []) live.delete(k);
        } else if (record && typeof record === "object") {
          for (const [k, v] of Object.entries(record)) live.set(k, v);          // the earlier format
        }
        lines++;
      }
      return Object.fromEntries(live);
    },
    write: async (puts, deletes) => {
      for (const [k, v] of Object.entries(puts)) live.set(k, v);
      for (const k of deletes) live.delete(k);
      if (lines + 1 > 2 * live.size + 64) {
        await fs.writeFile(`${path}.tmp`, compactLine());
        await fs.rename(`${path}.tmp`, path);
        lines = 1;
      } else {
        await fs.appendFile(path, JSON.stringify({ p: puts, d: deletes }) + "\n");
        lines++;
      }
    },
  });
}

/** Deno KV: `kv` is a Deno.Kv; keys live under ["ghost", prefix, key]. */
export function denoKvStore(kv, prefix = "default") {
  const base = ["ghost", prefix];
  return cachedStore({
    read: async () => {
      const all = {};
      for await (const entry of kv.list({ prefix: base })) all[entry.key[base.length]] = entry.value;
      return all;
    },
    write: async (puts, deletes) => {
      const changes = [...Object.entries(puts).map(([k, v]) => ["set", k, v]), ...deletes.map((k) => ["delete", k])];
      for (const group of groups(changes, 500)) {
        const op = kv.atomic();
        for (const [kind, k, v] of group) kind === "set" ? op.set([...base, k], v) : op.delete([...base, k]);
        await op.commit();
      }
    },
  });
}

/** Durable Object storage (Cloudflare): `storage` is the DurableObjectStorage of the object. */
export function durableObjectStore(storage) {
  return cachedStore({
    read: async () => Object.fromEntries(await storage.list()),
    write: async (puts, deletes) => {
      for (const group of groups(Object.entries(puts), 128)) await storage.put(Object.fromEntries(group));
      for (const group of groups(deletes, 128)) await storage.delete(group);
    },
  });
}

/**
 * A store over storage that several instances share.  The state is a set of entries with one version that every write raises by one: a request reads the version (and the entries
 * only when it is not the one already held), the module works on that, and `flush` commits what it changed *if the version is still the one it read*.  A commit that lost
 * writes nothing (`flush` is `false`) and the next `load` reads what the winner wrote.  Reads of one request see one version: they are not torn by a write in between.
 */
export function versionedStore(shared) {
  let committed = new Map();
  let version = "";                          // "" = nothing read yet
  let stale = false;                         // a commit lost: what is held is behind, whatever `load` is asked
  let puts = new Map();
  let deletes = new Set();
  return {
    async load(force = false) {
      puts = new Map();
      deletes = new Set();
      if (version && !force && !stale) return;
      const read = await shared.read(version);
      if (read.entries) committed = new Map(Object.entries(read.entries));
      version = read.version;
      stale = false;
    },
    get: (key) => (deletes.has(key) ? undefined : puts.has(key) ? puts.get(key) : committed.get(key)),
    put(key, value) { puts.set(key, value); deletes.delete(key); },
    delete(key) { puts.delete(key); deletes.add(key); },
    async flush() {
      if (puts.size === 0 && deletes.size === 0) return true;
      const [p, d] = [puts, deletes];
      puts = new Map();
      deletes = new Set();
      const result = await shared.commit(version, Object.fromEntries(p), [...d]);
      if (!result.ok) { stale = true; return false; }
      for (const [k, v] of p) committed.set(k, v);
      for (const k of d) committed.delete(k);
      version = result.version;
      return true;
    },
  };
}

/** The reference of `shared` of versionedStore, in memory: what a storage must do, and what the tests of the others are held against. */
export function memoryShared() {
  let entries = new Map();
  let version = 0;
  return {
    async read(seen) { return String(version) === seen ? { version: seen } : { version: String(version), entries: Object.fromEntries(entries) }; },
    async commit(expected, puts, deletes) {
      if (String(version) !== expected) return { ok: false, version: String(version) };
      for (const [k, v] of Object.entries(puts)) entries.set(k, v);
      for (const k of deletes) entries.delete(k);
      return { ok: true, version: String(++version) };
    },
  };
}

// Both are one atomic script each (Redis runs a script without another command in between), over two keys: the version and a hash of the entries.
//   read   ARGV[1] the version the caller holds           → { version } | { version, flat hash }
//   commit ARGV[1] the version it read, [2] seconds to live (0 = for ever), [3] puts, [4] deletes, then the puts as key, value pairs and the deletes → { 1, version } | { 0, version }
const READ = `local v = redis.call('GET', KEYS[1]) or '0'
if v == ARGV[1] then return { v } end
return { v, redis.call('HGETALL', KEYS[2]) }`;
const COMMIT = `local v = redis.call('GET', KEYS[1]) or '0'
if v ~= ARGV[1] then return { 0, v } end
local np, nd, at = tonumber(ARGV[3]), tonumber(ARGV[4]), 5
for _ = 1, np do redis.call('HSET', KEYS[2], ARGV[at], ARGV[at + 1]); at = at + 2 end
for _ = 1, nd do redis.call('HDEL', KEYS[2], ARGV[at]); at = at + 1 end
v = tostring(redis.call('INCR', KEYS[1]))
local ttl = tonumber(ARGV[2])
if ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl); redis.call('EXPIRE', KEYS[2], ttl) end
return { 1, v }`;

/**
 * `shared` over Redis through Upstash's REST API (the one that works where there is no TCP socket: an edge function).  `namespace` keeps instances of the state apart (a room);
 * `ttl` (seconds, 0 = none) lets a namespace that nobody writes to any more disappear.  A storage that does not answer is an error that says `unavailable`, which the core answers
 * with a 503 instead of a state it does not have.
 */
export function upstashShared({ url, token, namespace = "main", ttl = 0, timeoutMs = 8000, fetch: doFetch = fetch }) {
  const keys = [`ghost:{${namespace}}:v`, `ghost:{${namespace}}:h`];
  const unavailable = (message) => Object.assign(new Error(`the shared store is unavailable: ${message}`), { unavailable: true });
  const eval_ = async (script, ...args) => {
    let response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(["EVAL", script, keys.length, ...keys, ...args]),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw unavailable(e?.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : String(e?.cause?.code ?? e?.message ?? e)); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw unavailable(`it answered ${response.status}${body.error ? ` (${String(body.error).slice(0, 120)})` : ""}`);
    return body.result;
  };
  return {
    async read(seen) {
      const [version, flat] = await eval_(READ, seen);
      if (!flat) return { version };
      const entries = {};
      for (let i = 0; i < flat.length; i += 2) entries[flat[i]] = flat[i + 1];
      return { version, entries };
    },
    async commit(expected, puts, deletes) {
      const pairs = Object.entries(puts).flat();
      const [ok, version] = await eval_(COMMIT, expected, String(ttl), String(pairs.length / 2), String(deletes.length), ...pairs, ...deletes);
      return { ok: ok === 1, version };
    },
  };
}
