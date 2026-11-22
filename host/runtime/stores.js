// The stores a module persists its state in.  A module is synchronous and a platform's storage is not, so every store is a cache:
// `load()` reads what the module may ask for into memory, `get` / `put` / `delete` work on the cache, `flush()` writes what changed.
// The core calls load() before and flush() after each request.  One implementation does the caching; a platform supplies the two
// functions that talk to its storage.
//
//   cachedStore({ read, write })   read(): Promise<Record<string, string>>   write(puts, deletes): Promise<void>

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
      if (puts.size === 0 && deletes.size === 0) return;
      const p = Object.fromEntries(puts), d = [...deletes];
      puts = new Map();
      deletes = new Set();
      await write(p, d);
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
