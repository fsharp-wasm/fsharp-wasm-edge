// The state that instances share (Vercel, Netlify): what a storage must do for it, the module over several instances that race for one state, and the app that fails closed.
//   node tests/host/shared-store.mjs [module.wasm]        needs redis-server for the real-storage half (REQUIRE_REDIS=1 makes its absence a failure, as in CI)
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../host/runtime/server.js";
import { sharedApp } from "../../host/runtime/shared.js";
import { memoryShared, upstashShared, versionedStore } from "../../host/runtime/stores.js";
import { redisServer, startUpstash } from "../platforms/upstash.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const wasm = await readFile(process.argv[2] ?? join(root, "fixtures/GhostTodo.wasm"));
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const call = async (app, method, path, body) => {
  const response = await app.fetch(new Request(`http://x${path}`, { method, body, headers: body ? { "content-type": "application/json" } : {} }));
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, headers: response.headers, json: type.includes("json") ? await response.json() : null, text: type.includes("json") ? "" : await response.text() };
};
const add = (app, text) => call(app, "POST", "/api/todos", JSON.stringify({ text }));
const instance = (shared, extra = {}) => createServer({ module: wasm, hostName: "test", reload: true, store: versionedStore(shared), ...extra });

// ---- what a storage must do: the same checks for the reference and for Redis --------------------------------------------------------------------------------------------
async function contract(label, make) {
  const shared = make();
  let r = await shared.read("");
  check(`${label}: a state nobody wrote is version 0 and has no entries`, r.version === "0" && same(r.entries, {}), JSON.stringify(r));
  r = await shared.commit("0", { a: "1", b: "ü✓🚀" }, []);
  check(`${label}: a commit against the version that was read succeeds and raises it by one`, r.ok && r.version === "1", JSON.stringify(r));
  r = await shared.commit("0", { a: "stale" }, []);
  check(`${label}: a commit against an older version writes nothing and says which version stands`, !r.ok && r.version === "1", JSON.stringify(r));
  r = await shared.read("0");
  check(`${label}: a read of an older version gets the entries, UTF-8 intact`, r.version === "1" && same(r.entries, { a: "1", b: "ü✓🚀" }), JSON.stringify(r));
  r = await shared.read("1");
  check(`${label}: a read of the current version gets no entries`, r.version === "1" && r.entries === undefined, JSON.stringify(r));
  r = await shared.commit("1", { c: "" }, ["a", "missing"]);
  const after = await shared.read("");
  check(`${label}: puts and deletes in one commit; an empty value is a value; deleting what is not there is no error`, r.ok && same(after.entries, { b: "ü✓🚀", c: "" }), JSON.stringify(after));
  const wide = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, `v${i}`]));
  r = await shared.commit("2", wide, []);
  check(`${label}: a commit of 3 000 entries (no limit on the arguments of a script)`, r.ok && Object.keys((await shared.read("")).entries).length === 3002, JSON.stringify(r));
  // N commits against one version: exactly one wins
  const base = (await shared.read("")).version;
  const race = await Promise.all(Array.from({ length: 16 }, (_, i) => shared.commit(base, { winner: String(i) }, [])));
  check(`${label}: 16 commits against one version, exactly one wins`, race.filter((x) => x.ok).length === 1 && new Set(race.map((x) => x.version)).size <= 2, JSON.stringify(race));
}
await contract("memory", () => memoryShared());

const redis = await startUpstash();
if (!redis) {
  const need = process.env.REQUIRE_REDIS === "1";
  check(`redis-server is installed (${redisServer() ?? "not found"}): the real-storage half ${need ? "cannot be skipped" : "is skipped here"}`, !need);
}
const storages = [["memory", () => memoryShared()]];
if (redis) {
  let n = 0;
  const upstash = (opts = {}) => upstashShared({ url: redis.url, token: redis.token, namespace: `t${n}`, ...opts });
  const fresh = () => { n++; return upstash(); };
  await contract("redis", fresh);
  storages.push(["redis", fresh]);

  const r = (n++, upstash({ ttl: 100 }));
  await r.commit("0", { a: "1" }, []);
  const ttls = [await redis.command("TTL", `ghost:{t${n}}:v`), await redis.command("TTL", `ghost:{t${n}}:h`)];
  check("redis: a namespace with a time to live expires both of its keys", ttls.every((t) => t > 0 && t <= 100), ttls.join());
  const other = (n++, upstash());
  await other.commit("0", { a: "x" }, []);
  check("redis: namespaces are apart, and one with no time to live keeps its keys", (await redis.command("TTL", `ghost:{t${n}}:v`)) === -1 && (await upstash({ namespace: "empty" }).read("")).version === "0");

  // a storage that is not there, or says no, is `unavailable`
  const down = upstashShared({ url: "http://127.0.0.1:9", token: "x", timeoutMs: 500 });
  const wrongToken = upstashShared({ url: redis.url, token: "wrong" });
  const errors = await Promise.all([down.read(""), wrongToken.read("")].map((p) => p.then(() => null, (e) => e)));
  check("redis: no storage and a wrong token are errors that say `unavailable`, and the token is not in the message", errors.every((e) => e?.unavailable && !e.message.includes("wrong")) && /401/.test(errors[1]?.message ?? ""), errors.map((e) => e?.message).join(" | "));
}

// ---- the module over instances that share one state ---------------------------------------------------------------------------------------------------------------------
for (const [label, make] of storages) {
  const shared = make();
  const instances = Array.from({ length: 6 }, () => instance(shared));
  // 6 instances, 8 adds each, all at once: every add is one version, and no version is given twice
  const N = 8;
  const results = await Promise.all(instances.flatMap((app, i) => Array.from({ length: N }, (_, j) => add(app, `i${i} #${j}`))));
  const versions = results.map((x) => x.json?.version).sort((a, b) => a - b);
  check(`${label}: ${instances.length * N} adds through ${instances.length} instances at once are ${instances.length * N} consecutive versions`, results.every((x) => x.status === 201) && versions.join() === Array.from({ length: instances.length * N }, (_, i) => i + 1).join(), `${results.map((x) => x.status).join()} / ${versions.join()}`);
  const seen = await Promise.all(instances.map((app) => call(app, "GET", "/api/state")));
  check(`${label}: every instance then answers the same list of ${instances.length * N}`, seen.every((s) => s.json.todos.length === instances.length * N && same(s.json, seen[0].json)));
  await Promise.all(instances.map((app) => app.settled()));
  const cold = instance(shared);
  const state = (await call(cold, "GET", "/api/state")).json;
  check(`${label}: an instance that starts cold holds the same state, after the checkpoints that the module's idle calls wrote`, same(state, seen[0].json), `${state.version} vs ${seen[0].json.version}`);
  const patches = (await call(cold, "GET", `/api/patches?since=${state.version - 5}`)).json;
  check(`${label}: … and the patches of the last versions, in order`, patches.patches?.length === 5 && patches.patches.every((p, i) => p.version === state.version - 4 + i), JSON.stringify(patches).slice(0, 100));

  // mutations and checkpoints on two instances in turn, a long run: the log is folded in the middle of it
  const [a, b] = [instance(shared), instance(shared)];
  for (let i = 0; i < 90; i++) await Promise.all([add(a, `a${i}`), add(b, `b${i}`)]);
  await Promise.all([a.settled(), b.settled()]);
  const end = (await call(instance(shared), "GET", "/api/state")).json;
  check(`${label}: 180 more adds from two instances, in pairs: ${end.version} versions, no loss`, end.version === instances.length * N + 180 && end.todos.length === instances.length * N + 180, `${end.version} / ${end.todos.length}`);
}

// ---- a lost commit: the request runs again, and the answer is of the state the winner left -------------------------------------------------------------------------------
{
  const inner = memoryShared();
  const rival = instance(inner);
  let runs = 0, armed = true;
  const loses = {
    read: (seen) => inner.read(seen),
    commit: async (expected, puts, deletes) => {
      runs++;
      if (armed) { armed = false; await add(rival, "the rival, in between"); }      // someone else commits between this request's read and its commit
      return inner.commit(expected, puts, deletes);
    },
  };
  const app = instance(loses);
  const result = await add(app, "mine");
  check("a request whose commit lost runs again over the winner's state: version 2, not 1", result.status === 201 && result.json.version === 2 && runs === 2, JSON.stringify([result.status, result.json?.version, runs]));
  const list = (await call(app, "GET", "/api/state")).json.todos.map((t) => t.text);
  check("… and both writes are there", same(list, ["the rival, in between", "mine"]), list.join());

  // a state that always loses: 503 after the attempts, with the time to wait, and nothing written
  let tried = 0;
  const busy = instance({ read: (seen) => inner.read(seen), commit: async () => { tried++; return { ok: false, version: "999" }; } });
  const lost = await add(busy, "never");
  check("a request that loses every attempt is a 503 with `retry-after`, after 12 attempts", lost.status === 503 && lost.headers.get("retry-after") === "1" && tried === 12, `${lost.status} ${tried}`);

  // a storage that does not answer is a 503 that says so, not a state it does not have
  const gone = instance(upstashShared({ url: "http://127.0.0.1:9", token: "x", timeoutMs: 300 }));
  const unreachable = await call(gone, "GET", "/api/state");
  check("a storage that is not there is a 503 that says it", unreachable.status === 503 && /unavailable/.test(unreachable.text), `${unreachable.status} ${unreachable.text}`);
}

// ---- the app: rooms, and no fallback to memory --------------------------------------------------------------------------------------------------------------------------
{
  const assets = { "/": { type: "text/html", body: "<title>page</title>" } };
  const env = (vars) => (name) => vars[name];
  const unconfigured = sharedApp({ module: wasm, hostName: "test", env: env({}), assets });
  const noStore = await call(unconfigured, "GET", "/api/state");
  check("no store configured: 503 that names the variables, and the page is still served", noStore.status === 503 && /UPSTASH_REDIS_REST_URL/.test(noStore.text) && (await call(unconfigured, "GET", "/")).status === 200, `${noStore.status} ${noStore.text.slice(0, 80)}`);
  const half = sharedApp({ module: wasm, hostName: "test", env: env({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }), assets });
  check("only the URL configured: 503 that says it is half configured", /half configured/.test((await call(half, "GET", "/api/state")).text));
  const insecure = sharedApp({ module: wasm, hostName: "test", env: env({ UPSTASH_REDIS_REST_URL: "http://db.example.com", UPSTASH_REDIS_REST_TOKEN: "t" }), assets });
  check("a token is never sent over http to a host that is not a loopback address", /must be https/.test((await call(insecure, "GET", "/api/state")).text));
  const vercelNames = sharedApp({ module: wasm, hostName: "test", env: env({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }), assets });
  check("the names that Vercel's integration sets are read too", vercelNames.describe().store === "upstash");

  if (redis) {
    const app = sharedApp({ module: wasm, hostName: "test", env: env({ UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token }), assets });
    const inRoom = (room, method, path, body) => call(app, method, `${path}${path.includes("?") ? "&" : "?"}room=${room}`, body);
    await inRoom("one", "POST", "/api/todos", JSON.stringify({ text: "in one" }));
    await inRoom("one", "POST", "/api/todos", JSON.stringify({ text: "in one, again" }));
    await inRoom("two", "POST", "/api/todos", JSON.stringify({ text: "in two" }));
    const [one, two] = [(await inRoom("one", "GET", "/api/state")).json, (await inRoom("two", "GET", "/api/state")).json];
    check("rooms are states of their own", one.version === 2 && two.version === 1 && one.todos[0].text === "in one" && two.todos[0].text === "in two", JSON.stringify([one.version, two.version]));
    check("a room that is not a name is 400", (await inRoom("a%20b", "GET", "/api/state")).status === 400 && (await inRoom("x".repeat(65), "GET", "/api/state")).status === 400);
    const ttl = await redis.command("TTL", "ghost:{one}:v");
    check("a room other than the default expires after a day; the default room does not", ttl > 80000 && ttl <= 86400 && (await call(app, "POST", "/api/todos", JSON.stringify({ text: "main" }))).status === 201 && (await redis.command("TTL", "ghost:{main}:v")) === -1, String(ttl));
    const another = sharedApp({ module: wasm, hostName: "test", env: env({ UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token }), assets });
    check("a second app (another instance of the platform) answers from the same state", (await call(another, "GET", "/api/state?room=one")).json.version === 2);
    const wrong = sharedApp({ module: wasm, hostName: "test", env: env({ UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: "wrong" }), assets });
    const denied = await call(wrong, "GET", "/api/state");
    check("a wrong token is a 503 that says 401, not an empty state", denied.status === 503 && /401/.test(denied.text), `${denied.status} ${denied.text}`);
  }
}

await redis?.stop();
console.log(failed ? `\n${failed} check(s) failed` : "\nall shared-store checks passed");
process.exit(failed ? 1 : 0);
