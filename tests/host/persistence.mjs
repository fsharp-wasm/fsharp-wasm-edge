// How the host and the Ghost Todo persist: a mutation writes its patch only, the checkpoint is folded by the module's `idle` call after the response, a cold start reads both back,
// and the file store of Node and Bun is a journal that costs what a request wrote, not the size of the state.
//   node tests/host/persistence.mjs [module.wasm]        (default: fixtures/GhostTodo.wasm)
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../host/runtime/server.js";
import { cachedStore, fileStore } from "../../host/runtime/stores.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const wasm = await readFile(process.argv[2] ?? join(root, "fixtures/GhostTodo.wasm"));
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };

// ---- the module on the host, over a store that remembers what each flush wrote ------------------------------------------------------------------------------------------
const disk = new Map();
const flushes = [];
const recording = () => cachedStore({
  read: async () => Object.fromEntries(disk),
  write: async (puts, deletes) => {
    flushes.push({ puts: Object.keys(puts), bytes: Object.values(puts).reduce((n, v) => n + v.length, 0), deletes });
    for (const [k, v] of Object.entries(puts)) disk.set(k, v);
    for (const k of deletes) disk.delete(k);
  },
});
const call = async (app, method, path, body) => {
  const response = await app.fetch(new Request(`http://x${path}`, { method, body, headers: body ? { "content-type": "application/json" } : {} }));
  return { status: response.status, json: response.headers.get("content-type")?.includes("json") ? await response.json() : null };
};

const app = createServer({ module: wasm, hostName: "test", store: recording() });
const N = 150;
for (let i = 1; i <= N; i++) {
  await call(app, "POST", "/api/todos", JSON.stringify({ text: `todo ${i}` }));
  if (i % 3 === 0) await call(app, "POST", `/api/todos/${i - 1}/toggle`);
}
await app.settled();
const versions = (await call(app, "GET", "/api/state")).json.version;

const requestFlushes = flushes.filter((f) => !f.puts.includes("state"));
const checkpointFlushes = flushes.filter((f) => f.puts.includes("state"));
check(`every request wrote its patch only: at most ${Math.max(...requestFlushes.map((f) => f.bytes))} characters in ${requestFlushes.length} flushes`, requestFlushes.length > 0 && requestFlushes.every((f) => f.bytes < 200 && f.puts.length === 1 && f.puts[0].startsWith("log/")));
check(`the checkpoint came in flushes of its own (${checkpointFlushes.length}), after the answers`, checkpointFlushes.length >= 1 && checkpointFlushes.every((f) => f.puts.every((k) => !k.startsWith("log/"))));
const logKeys = [...disk.keys()].filter((k) => k.startsWith("log/"));
check(`the log beyond the last checkpoint is short: ${logKeys.length} entries of ${versions} versions`, logKeys.length < 64 && disk.has("state"));

const cold = createServer({ module: wasm, hostName: "cold", store: recording() });
const [before, after] = [(await call(app, "GET", "/api/state")).json, (await call(cold, "GET", "/api/state")).json];
check("a cold start over the same storage holds the same list at the same version", after.version === before.version && JSON.stringify(after.todos) === JSON.stringify(before.todos) && before.todos.length > 0, `${after.version} vs ${before.version}`);
const patches = (await call(cold, "GET", `/api/patches?since=${before.version - 3}`)).json;
check("… and serves the patches of the last versions without a resync", Array.isArray(patches.patches) && patches.patches.length === 3, JSON.stringify(patches).slice(0, 120));

// ---- the JavaScript reference of the benchmark persists the same way, and reads it back ----------------------------------------------------------------------------------
{
  const { createLogic } = await import("../../bench/logic.mjs");
  const js = new Map();
  const store = { get: (k) => js.get(k), put: (k, v) => js.set(k, v), delete: (k) => js.delete(k) };
  const first = createLogic({ store });
  for (let i = 1; i <= 100; i++) { first.add(`todo ${i}`); if (i % 3 === 0) first.toggle(i - 1); }
  await new Promise((r) => setTimeout(r, 0));                                       // the checkpoint is a microtask
  const second = createLogic({ store });
  check(`the reference over the same store holds the same list (${js.size} key(s) left in the store: the checkpoint, and what came after)`, JSON.stringify(second.state()) === JSON.stringify(first.state()) && js.has("state") && js.size < 70);
  check("… and its next id", second.add("next").body.todo.id === first.add("next").body.todo.id);
}

// ---- storages that take a limited number of keys per call get what they can take ---------------------------------------------------------------------------------------
{
  const { durableObjectStore } = await import("../../host/runtime/stores.js");
  const calls = [];
  const storage = { list: async () => new Map(), put: async (o) => calls.push(["put", Object.keys(o).length]), delete: async (ks) => calls.push(["delete", ks.length]) };
  const store = durableObjectStore(storage);
  await store.load();
  for (let i = 0; i < 300; i++) store.put(`k${i}`, "v");
  for (let i = 0; i < 300; i++) store.delete(`gone${i}`);
  await store.flush();
  check(`a Durable Object gets at most 128 keys a call (${calls.map((c) => c.join(" ")).join(", ")})`, calls.length >= 6 && calls.every(([, n]) => n <= 128) && calls.filter((c) => c[0] === "put").reduce((n, c) => n + c[1], 0) === 300 && calls.filter((c) => c[0] === "delete").reduce((n, c) => n + c[1], 0) === 300);
}

// ---- the file store is a journal ----------------------------------------------------------------------------------------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), "ghost-journal-"));
try {
  const path = join(dir, "state.jsonl");
  const open = async () => { const s = fileStore(path, fsp); await s.load(); return s; };
  let s = await open();
  s.put("big", "x".repeat(200_000)); s.put("a", "1"); await s.flush();
  const base = (await stat(path)).size;
  for (let i = 0; i < 100; i++) { s.put(`log/${i}`, "00".repeat(20)); s.delete(`log/${i - 5}`); await s.flush(); }
  const grown = (await stat(path)).size - base;
  check(`100 small writes added ${grown} bytes to a file of ${base}: nothing was rewritten`, grown < 20_000, String(grown));
  s = await open();
  check("it reads back: the last write of a key stands, a deleted key is gone", s.get("a") === "1" && s.get("big").length === 200_000 && s.get("log/99") !== undefined && s.get("log/95") !== undefined && s.get("log/94") === undefined && s.get("log/20") === undefined);
  await appendFile(path, '{"p":{"torn":"half a li');                              // a write that was cut short
  s = await open();
  check("a line that was cut short ends the journal there", s.get("a") === "1" && s.get("torn") === undefined);
  for (let i = 0; i < 300; i++) { s.put("counter", String(i)); await s.flush(); }
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
  s = await open();
  check(`a journal that outgrows its content is rewritten as one (${lines} lines after 300 writes)`, lines < 300 && s.get("counter") === "299" && s.get("a") === "1");
  await writeFile(path, JSON.stringify({ state: "earlier format" }));
  s = await open();
  check("a file of the earlier format, one object, is read as it is", s.get("state") === "earlier format");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall persistence checks passed");
process.exit(failed ? 1 : 0);
