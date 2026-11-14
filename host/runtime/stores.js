// The stores a module persists its state in.  A module is synchronous and a platform's storage is not, so every store is a cache:
// `load()` reads what the module may ask for into memory, `get` / `put` / `delete` work on the cache, `flush()` writes what changed.
// The core calls load() before and flush() after each request.  One implementation does the caching; a platform supplies the two
// functions that talk to its storage.
//
//   cachedStore({ read, write })   read(): Promise<Record<string, string>>   write(puts, deletes): Promise<void>

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

/** A JSON file (Node, Bun): the whole state in one file, replaced atomically. */
export function fileStore(path, fs) {
  return cachedStore({
    read: async () => {
      try { return JSON.parse(await fs.readFile(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
    },
    write: async (puts, deletes) => {
      let all = {};
      try { all = JSON.parse(await fs.readFile(path, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
      for (const d of deletes) delete all[d];
      Object.assign(all, puts);
      await fs.writeFile(`${path}.tmp`, JSON.stringify(all));
      await fs.rename(`${path}.tmp`, path);
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
      const op = kv.atomic();
      for (const [k, v] of Object.entries(puts)) op.set([...base, k], v);
      for (const k of deletes) op.delete([...base, k]);
      await op.commit();
    },
  });
}

/** Durable Object storage (Cloudflare): `storage` is the DurableObjectStorage of the object. */
export function durableObjectStore(storage) {
  return cachedStore({
    read: async () => Object.fromEntries(await storage.list()),
    write: async (puts, deletes) => {
      if (Object.keys(puts).length) await storage.put(puts);
      if (deletes.length) await storage.delete(deletes);
    },
  });
}
