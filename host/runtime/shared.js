// What Vercel and Netlify run on: no instance lives long, any request may reach another one, and none of them holds the state.  The state is in Redis (Upstash, over its REST API: an
// edge function has no TCP socket), one namespace per room, and every request reads the version, runs the module over it and commits only if the version is still the one it read
// (stores.js: versionedStore, upstashShared).  Instances that race for the same state make progress one after another: the loser of a commit runs its request again (server.js).
//
//   const app = sharedApp({ module, hostName: "vercel-edge", env: (name) => process.env[name], assets });
//   export default (request, context) => { context?.waitUntil?.(app.settled()); return app.fetch(request); };
//
// There is no fallback to memory: an instance that cannot reach the store answers 503 and says why, because a state that differs from instance to instance is a bug that looks like
// working until a second instance answers.
import { compileModule, createServer, pathBelow, serveAsset } from "./server.js";
import { upstashShared, versionedStore } from "./stores.js";

export const DEFAULT_ROOM = "main";
/** A room other than the default is a scratch state (a test, a visitor's own): it is forgotten a day after its last write. */
export const ROOM_TTL_SECONDS = 24 * 60 * 60;
const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
/** How many rooms one instance keeps a server for: the state is in the store, so the server of the room that was used longest ago is dropped. */
const MAX_ROOMS = 32;

const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" } });

/** The store of the environment: Upstash's own names, or the ones Vercel's integration sets.  `null` when nothing is configured; an error for what cannot be right. */
export function storeConfig(env) {
  const url = env("UPSTASH_REDIS_REST_URL") ?? env("KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN") ?? env("KV_REST_API_TOKEN");
  if (!url && !token) return null;
  if (!url || !token) throw new Error("the shared store is half configured: both the REST URL and the REST token are needed (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL and KV_REST_API_TOKEN)");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("the REST URL of the shared store is not a URL"); }
  // the token goes with every request: not over a connection that anyone on the way can read (a loopback address is the test's own)
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("the REST URL of the shared store must be https");
  return { url, token };
}

/** The room a request asks for (`?room=`), the default one, or `null` when the name is not one. */
export function roomOf(request) {
  const room = new URL(request.url).searchParams.get("room") ?? DEFAULT_ROOM;
  return ROOM.test(room) ? room : null;
}

/**
 * @param {object}   options   those of createServer, without `store` and `reload`, and
 * @param {(name: string) => string | undefined} options.env  how the platform reads its environment
 * @param {typeof fetch} [options.fetch]                        for the store's REST calls (default: the global one)
 */
export function sharedApp({ module, env, fetch: doFetch, assets = {}, ...options }) {
  let config, configError = null;
  try { config = storeConfig(env); } catch (e) { config = null; configError = e.message; }
  const compiled = compileModule(module);          // once: every room's server shares it
  const rooms = new Map();
  const serverOf = (room) => {
    let server = rooms.get(room);
    if (server) rooms.delete(room);
    else {
      if (rooms.size >= MAX_ROOMS) rooms.delete(rooms.keys().next().value);
      const shared = upstashShared({ ...config, namespace: room, ttl: room === DEFAULT_ROOM ? 0 : ROOM_TTL_SECONDS, fetch: doFetch });
      server = createServer({ ...options, module: compiled, reload: true, store: versionedStore(shared) });
    }
    rooms.set(room, server);
    return server;
  };
  return {
    fetch(request) {
      // the pages and files are served whatever the store says: they hold no state
      const asset = serveAsset(assets, request, options.basePath);
      if (asset) return Promise.resolve(asset);
      if (pathBelow(options.basePath, request) === null) return Promise.resolve(new Response("not found", { status: 404 }));
      if (!config) {
        return Promise.resolve(text(503, `${configError ?? "no shared store is configured"}: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) in the environment of this deployment; docs/deploy.md, Shared state`));
      }
      const room = roomOf(request);
      if (!room) return Promise.resolve(new Response("a room is 1 to 64 letters, digits, - or _", { status: 400 }));
      return serverOf(room).fetch(request);
    },
    /** Resolves when every task of every room has run: what a platform that ends an instance after the response waits for. */
    settled: () => Promise.all([...rooms.values()].map((server) => server.settled())).then(() => undefined),
    describe: () => ({ hostName: options.hostName, store: config ? "upstash" : "none", rooms: rooms.size }),
  };
}
