// The Ghost Todo API in JavaScript: the same model, the same GGBP patches, the same persistence (a mutation writes its patch, a checkpoint folds the log) as demos/ghost-todo of fsharp-wasm-backend — so that
// what the benchmark compares is the module and the framework, not two different programs.  `createLogic({ store })` answers
// { status, body } (a JSON-able value, or the bytes of a patch) for the routes of the API; the callers (js-app.mjs, hono-app.mjs) only route.
import { encode, decode, applyPatch, decodeRecord, toHex, fromHex, ListOp, WasmType } from "../host/client/ggbp.js";

const utf8 = new TextEncoder();
const varint = (v) => { const out = []; do { let b = v & 0x7f; v >>>= 7; out.push(v ? b | 0x80 : b); } while (v); return out; };
const record = (t) => Uint8Array.from([...varint(t.id), t.done ? 1 : 0, ...utf8.encode(t.text)]);
const MAX_LOG = 64, MAX_TEXT = 200, COMPACT_EVERY = 64;
const logKey = (version) => `log/${version}`;

/** The model after the patch of `hex`; null when it is not the next version or does not apply (the log ends there). */
function replay(m, hex) {
  try {
    const patch = decode(fromHex(hex));
    const shadow = applyPatch({ version: m.version, todos: m.todos.map((t) => ({ ...t })) }, patch);
    let nextId = m.nextId;
    for (const o of patch.ops) if (o.op === "listMutation" && o.nodeId === 0 && o.field === 0 && o.listOp === ListOp.Insert) nextId = Math.max(nextId, decodeRecord(o.value).id + 1);
    return { version: shadow.version, nextId, todos: shadow.todos, log: [{ version: patch.version, transaction: patch.transaction, hex }, ...m.log].slice(0, MAX_LOG) };
  } catch { return null; }
}

export function createLogic({ store }) {
  let model = null;
  let checkpoint = 0;
  /** The checkpoint of the store, and every patch after it that the store holds. */
  const load = () => {
    if (model) return model;
    const text = store.get("state");
    model = (text ? JSON.parse(text) : null) ?? { version: 0, nextId: 1, todos: [], log: [] };
    checkpoint = model.version;
    for (;;) {
      const hex = store.get(logKey(model.version + 1));
      const next = hex ? replay(model, hex) : null;
      if (!next) break;
      model = next;
    }
    return model;
  };
  /** The log folded into a checkpoint: the state is written, the entries it covers are dropped (the checkpoint first). */
  const compact = () => {
    if (model.version - checkpoint < COMPACT_EVERY) return;
    store.put("state", JSON.stringify({ version: model.version, nextId: model.nextId, todos: model.todos, log: model.log }));
    for (let v = checkpoint + 1; v <= model.version; v++) store.delete(logKey(v));
    checkpoint = model.version;
  };
  /** One mutation = one patch = one version step; what is persisted is the patch, as the F# module does (and nothing may stand behind the head of the log). */
  const commit = (m, ops, txn) => {
    const version = m.version + 1;
    const transaction = txn ?? version;
    const hex = toHex(encode({ version, transaction, ops }));
    m.version = version;
    m.log = [{ version, transaction, hex }, ...m.log].slice(0, MAX_LOG);
    store.put(logKey(version), hex);
    store.delete(logKey(version + 1));
    if (version - checkpoint >= COMPACT_EVERY) queueMicrotask(compact);
    return { version, transaction, patch: hex };
  };
  const json = (status, body) => ({ status, body });
  const notFound = json(404, { error: "not found" });

  return {
    info: (host) => json(200, { module: "ghost-todo", host, version: load().version, todos: load().todos.length }),
    state: () => { const m = load(); return json(200, { version: m.version, todos: m.todos }); },
    add: (text, txn) => {
      if (typeof text !== "string") return json(400, { error: 'expected {"text": "…"}' });
      const m = load(), trimmed = text.trim();
      if (trimmed === "" || trimmed.length > MAX_TEXT) return json(400, { error: "the text must not be empty or longer than 200 characters" });
      const todo = { id: m.nextId, text: trimmed, done: false };
      const op = { op: "listMutation", nodeId: 0, field: 0, listOp: ListOp.Insert, index: m.todos.length, value: record(todo) };
      m.nextId++; m.todos = [...m.todos, todo];
      return json(201, { ...commit(m, [op], txn), todo });
    },
    toggle: (id, txn) => {
      const m = load(), t = m.todos.find((x) => x.id === id);
      if (!t) return notFound;
      const todo = { ...t, done: !t.done };
      m.todos = m.todos.map((x) => (x.id === id ? todo : x));
      return json(200, { ...commit(m, [{ op: "updateLeaf", nodeId: id, field: 1, wasmType: WasmType.I32, value: Uint8Array.of(todo.done ? 1 : 0) }], txn), todo });
    },
    remove: (id, txn) => {
      const m = load(), index = m.todos.findIndex((x) => x.id === id);
      if (index < 0) return notFound;
      const todo = m.todos[index];
      m.todos = m.todos.filter((x) => x.id !== id);
      return json(200, { ...commit(m, [{ op: "listMutation", nodeId: 0, field: 0, listOp: ListOp.Remove, index, value: new Uint8Array(0) }, { op: "deleteNode", nodeId: id }], txn), todo });
    },
    patches: (since) => {
      const m = load();
      if (since >= m.version) return json(200, { version: m.version, patches: [] });
      const wanted = m.log.filter((e) => e.version > since).reverse();
      return wanted.length && wanted[0].version === since + 1 && wanted.length === m.version - since
        ? json(200, { version: m.version, patches: wanted.map((e) => ({ version: e.version, transaction: e.transaction, hex: e.hex })) })
        : json(200, { version: m.version, resync: true });
    },
  };
}

/** The `since` of a request for patches: a non-negative integer, or null (the request is a 400). */
export const parseSince = (raw) => (typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null);
export const badSince = { status: 400, body: { error: "expected ?since=<version>" } };

export const respond = ({ status, body }) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
