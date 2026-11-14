// GGBP — the Ghost-Graph Binary Patch format — in JavaScript, and the shadow a client keeps of the Ghost Todo model.
// A patch is  Magic 0x47 | Version u32 LE | Transaction u32 LE | OpCount varint | ops   (see FSharp.Wasm.Server/Ggbp.fs).
// The list is node 0 (field 0 holds the todos); a todo is the node of its id (field 0 = text, field 1 = done).

export const MAGIC = 0x47;
export const WasmType = { I32: 0, I64: 1, F32: 2, F64: 3, RefStruct: 4, RefArray: 5, RefString: 6, RefFunc: 7, RefAny: 8 };
export const ListOp = { Insert: 0, Remove: 1, Update: 2, Clear: 3 };

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  byte() { if (this.pos >= this.bytes.length) throw new Error("unexpected end of patch"); return this.bytes[this.pos++]; }
  u16() { return this.byte() | (this.byte() << 8); }
  u32() { return (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0; }
  varint() {
    let result = 0, shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 35) throw new Error("varint too long");
    }
  }
  blob() { const n = this.u16(); if (this.pos + n > this.bytes.length) throw new Error("blob past the end"); const b = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return b; }
}

/** Decode a GGBP patch: { version, transaction, ops }, an op being { op: "updateLeaf" | "replaceBranch" | "listMutation" | "deleteNode", … }. */
export function decode(bytes) {
  if (bytes.length < 1) throw new Error("empty payload");
  if (bytes[0] !== MAGIC) throw new Error("invalid magic");
  const r = new Reader(bytes);
  r.byte();
  const version = r.u32(), transaction = r.u32(), count = r.varint();
  if (count > bytes.length - r.pos) throw new Error("operation count beyond the payload");
  const ops = [];
  for (let i = 0; i < count; i++) {
    switch (r.byte()) {
      case 0x01: { const nodeId = r.varint(), field = r.byte(), wasmType = r.byte(); ops.push({ op: "updateLeaf", nodeId, field, wasmType, value: r.blob() }); break; }
      case 0x02: { const nodeId = r.varint(); ops.push({ op: "replaceBranch", nodeId, payload: r.blob() }); break; }
      case 0x03: { const nodeId = r.varint(), field = r.byte(), listOp = r.byte(), index = r.varint(); ops.push({ op: "listMutation", nodeId, field, listOp, index, value: r.blob() }); break; }
      case 0x04: ops.push({ op: "deleteNode", nodeId: r.varint() }); break;
      default: throw new Error("unknown operation tag");
    }
  }
  return { version, transaction, ops };
}

class Writer {
  constructor() { this.out = []; }
  byte(b) { this.out.push(b & 0xff); }
  u16(v) { this.byte(v); this.byte(v >> 8); }
  u32(v) { this.byte(v); this.byte(v >>> 8); this.byte(v >>> 16); this.byte(v >>> 24); }
  varint(v) { if (v === 0) return this.byte(0); while (v > 0) { const low = v & 0x7f; v >>>= 7; this.byte(v > 0 ? low | 0x80 : low); } }
  blob(b) { this.u16(b.length); for (const x of b) this.byte(x); }
}

/** The inverse of decode: the bytes of a patch (used to check that what the server sent round-trips). */
export function encode(patch) {
  const w = new Writer();
  w.byte(MAGIC); w.u32(patch.version); w.u32(patch.transaction); w.varint(patch.ops.length);
  for (const o of patch.ops) {
    if (o.op === "updateLeaf") { w.byte(1); w.varint(o.nodeId); w.byte(o.field); w.byte(o.wasmType); w.blob(o.value); }
    else if (o.op === "replaceBranch") { w.byte(2); w.varint(o.nodeId); w.blob(o.payload); }
    else if (o.op === "listMutation") { w.byte(3); w.varint(o.nodeId); w.byte(o.field); w.byte(o.listOp); w.varint(o.index); w.blob(o.value); }
    else { w.byte(4); w.varint(o.nodeId); }
  }
  return Uint8Array.from(w.out);
}

// ── the Ghost Todo schema ───────────────────────────────────────────────────

/** The record an Insert carries: id (varint) | done (1) | text (UTF-8). */
export function decodeRecord(bytes) {
  const r = new Reader(bytes);
  const id = r.varint(), done = r.byte() !== 0;
  return { id, done, text: new TextDecoder().decode(bytes.slice(r.pos)) };
}

/** A shadow: the model as the client holds it. */
export const emptyShadow = () => ({ version: 0, todos: [] });
export const shadowOf = (state) => ({ version: state.version, todos: state.todos.map((t) => ({ ...t })) });

/** Apply one patch to a shadow, in place.  The patch must follow the shadow's version: a gap means the client has to fetch the state. */
export function applyPatch(shadow, patch) {
  if (patch.version !== shadow.version + 1) throw new Error(`version gap: the shadow is at ${shadow.version}, the patch is ${patch.version}`);
  for (const o of patch.ops) {
    if (o.op === "listMutation" && o.nodeId === 0 && o.field === 0) {
      if (o.listOp === ListOp.Insert) shadow.todos.splice(o.index, 0, decodeRecord(o.value));
      else if (o.listOp === ListOp.Remove) shadow.todos.splice(o.index, 1);
      else if (o.listOp === ListOp.Clear) shadow.todos.length = 0;
      else throw new Error("unsupported list operation");
    } else if (o.op === "updateLeaf") {
      const todo = shadow.todos.find((t) => t.id === o.nodeId);
      if (!todo) throw new Error(`no todo ${o.nodeId}`);
      if (o.field === 1 && o.wasmType === WasmType.I32) todo.done = o.value[0] !== 0;
      else if (o.field === 0 && o.wasmType === WasmType.RefString) todo.text = new TextDecoder().decode(o.value);
      else throw new Error("unsupported leaf");
    } else if (o.op === "deleteNode") {
      // the list mutation of the same patch has removed it from the list; a node that is still listed goes with it
      const i = shadow.todos.findIndex((t) => t.id === o.nodeId);
      if (i >= 0) shadow.todos.splice(i, 1);
    } else throw new Error(`unsupported operation ${o.op}`);
  }
  shadow.version = patch.version;
  return shadow;
}
