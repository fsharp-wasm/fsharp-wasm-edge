// The same scenario on every platform.  `send(method, path, { body, headers })` returns { status, type, text, bytes }.  The scenario
// returns a transcript (what the API said, in order, with the host's name masked) and the checks it made; the runner compares the
// transcripts of all platforms: they must be identical.
import { isDeepStrictEqual } from "node:util";
import { decode, applyPatch, emptyShadow, shadowOf, encode, fromHex, toHex } from "../../host/client/ggbp.js";

export async function runScenario(send, { host }) {
  const transcript = [];
  const checks = [];
  const check = (name, ok, extra = "") => checks.push({ name, ok: Boolean(ok), extra: ok ? "" : String(extra) });
  const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
  const log = (label, r) => transcript.push([label, r.status, r.type.split(";")[0], r.text.split(host).join("<host>")]);
  const post = (path, body, headers = {}) => send("POST", path, { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  // ── the basics
  let r = await send("GET", "api/info"); log("info", r);
  check("info names the module and the host", json(r)?.module === "ghost-todo" && json(r)?.host === host, r.text);
  r = await send("GET", "healthz"); log("healthz", r);
  check("healthz", r.status === 200 && r.text === "ok");
  r = await send("GET", "api/nope"); log("unknown path", r);
  check("an unknown path is 404", r.status === 404);
  r = await send("DELETE", "healthz"); log("wrong method", r);
  check("a wrong method is 405", r.status === 405);
  r = await send("OPTIONS", "api/todos"); log("preflight", r);
  check("a preflight is 204 with the allowed methods", r.status === 204 && r.headers["access-control-allow-methods"]?.includes("POST"));
  r = await send("GET", "api/state");
  check("a CORS header on responses", r.headers["access-control-allow-origin"] === "*");
  r = await send("GET", ""); 
  check("the page is served", r.status === 200 && r.type.includes("text/html") && r.text.includes("Ghost Todo"), `${r.status} ${r.type}`);

  // ── mutations: every one is a GGBP patch
  r = await post("api/todos", { text: "Write the docs" }, { "x-transaction": "7" }); log("add", r);
  let j = json(r);
  check("add: 201, version 1, the transaction of the client", r.status === 201 && j?.version === 1 && j?.transaction === 7, r.text);
  let patch = decode(fromHex(j?.patch ?? ""));
  check("add: one ListMutation Insert on the list node", patch.ops.length === 1 && patch.ops[0].op === "listMutation" && patch.ops[0].nodeId === 0 && patch.ops[0].listOp === 0);
  check("add: the patch round-trips through the JS encoder byte for byte", toHex(encode(patch)) === j?.patch);

  r = await post("api/todos", { text: "Grüße ✓ 🚀 日本語" }); log("add unicode", r);
  j = json(r);
  check("unicode text survives UTF-8 in the patch", j?.todo?.text === "Grüße ✓ 🚀 日本語" && decode(fromHex(j.patch)).ops[0].value.length > 10, r.text);
  r = await post("api/todos", { text: "   " }); log("add empty", r);
  check("empty text is 400", r.status === 400);
  r = await post("api/todos", "{oops"); log("add malformed", r);
  check("malformed JSON is 400", r.status === 400);
  r = await post("api/todos", { text: "x".repeat(201) }); log("add too long", r);
  check("a text of 201 characters is 400", r.status === 400);

  r = await post("api/todos/1/toggle", ""); log("toggle", r);
  j = json(r);
  check("toggle: version 3, a leaf update of `done`", r.status === 200 && j?.version === 3 && decode(fromHex(j.patch)).ops[0].op === "updateLeaf", r.text);
  r = await post("api/todos/99/toggle", ""); log("toggle unknown", r);
  check("toggling an unknown todo is 404", r.status === 404);

  r = await send("GET", "api/state"); log("state", r);
  const state = json(r);
  check("state: two todos, version 3, the first done", state?.version === 3 && state?.todos?.length === 2 && state.todos[0].done === true, r.text);

  // ── the ghost: a client that holds a shadow and applies patches
  r = await send("GET", "api/patches?since=0"); log("patches since 0", r);
  const patches = json(r)?.patches ?? [];
  const shadow = emptyShadow();
  for (const p of patches) applyPatch(shadow, decode(fromHex(p.hex)));
  check("the shadow built from the patches equals the state", isDeepStrictEqual(shadow, shadowOf(state)), JSON.stringify(shadow));
  r = await send("GET", "api/patch/2");
  check("the binary patch endpoint equals the hex of the log", r.status === 200 && r.type.includes("octet-stream") && toHex(r.bytes) === patches[1]?.hex);
  r = await send("GET", "api/patches?since=3"); log("patches since the latest", r);
  check("no patches since the latest version", json(r)?.patches?.length === 0 && json(r)?.version === 3);
  r = await send("GET", "api/patches"); log("patches without since", r);
  check("`since` is required", r.status === 400);

  r = await send("DELETE", "api/todos/2"); log("remove", r);
  j = json(r);
  const removal = decode(fromHex(j?.patch ?? ""));
  check("remove: a list Remove and a DeleteNode in one patch", removal.ops.length === 2 && removal.ops[0].listOp === 1 && removal.ops[1].op === "deleteNode", r.text);
  applyPatch(shadow, removal);
  r = await send("GET", "api/state");
  check("the shadow follows the removal", isDeepStrictEqual(shadow, shadowOf(json(r))));

  // ── concurrency: requests are served one after the other, versions do not collide
  const before = json(await send("GET", "api/state")).version;
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => post("api/todos", { text: `parallel ${i}` })));
  const versions = burst.map((b) => json(b)?.version).sort((a, b) => a - b);
  check("12 parallel adds give 12 consecutive versions", versions.join() === Array.from({ length: 12 }, (_, i) => before + 1 + i).join(), versions.join());
  transcript.push(["parallel versions", 0, "", String(versions.length)]);

  // ── the log keeps the last 64 patches: an older client has to fetch the state again
  const first = json(await send("GET", "api/state")).todos[0].id;
  for (let i = 0; i < 70; i++) await post(`api/todos/${first}/toggle`, "");
  const now = json(await send("GET", "api/state")).version;
  r = await send("GET", "api/patches?since=0"); log("patches since 0 after 70 more", r);
  check("a client too far behind is told to resync", json(r)?.resync === true && json(r)?.version === now, r.text.slice(0, 80));
  r = await send("GET", `api/patches?since=${now - 3}`);
  check("a client close behind gets exactly what it misses", json(r)?.patches?.length === 3 && json(r).patches[0].version === now - 2, r.text.slice(0, 80));
  transcript.push(["final version", 0, "", String(now)]);

  return { transcript, checks, finalState: json(await send("GET", "api/state")) };
}
