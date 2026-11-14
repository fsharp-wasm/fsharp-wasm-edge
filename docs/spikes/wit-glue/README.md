# Spike: a WasmGC module as a WIT component

Question: can what fsharp-wasm compiles (a WasmGC module, no linear memory) be a **Component Model** component with a WIT world, so that the
platform adapters can be generated instead of hand-written? Measured with wasm-tools 1.263.0 and jco 1.42.0 on Node 24.

| what | result |
|---|---|
| a GC module exporting `add: func(s32, s32) -> s32` (`wasm-tools component embed` + `component new`) | a valid component (287 bytes): scalar signatures need no memory |
| a GC module exporting `greet: func(string) -> string` over GC arrays | **rejected**: `failed to classify export greet` |
| the same with the *lowered* signature `(i32, i32) -> i32` but no memory | **rejected**: `module does not export a memory named memory` |
| `glue.component.wat`: the GC module plus a second core module that owns a linear memory, `cabi_realloc`, and copies the string in and out of a GC array; the component lifts the glue's `greet` | **valid** (755 bytes); `wasm-tools component wit` prints `export greet: func(name: string) -> string` |
| `jco transpile glue.component.wasm` (inline core modules), run on Node 24 | `greet("Welt")` → `Hello, Welt`; `"Grüße ✓ 🚀 日本語"` round-trips through UTF-8 |
| `jco transpile --instantiation async` | `instantiate(getCoreModule, imports)`: the host hands over the core modules, so a platform that forbids compiling WebAssembly from bytes (Workers, Vercel Edge) can pass its precompiled `.wasm` imports. Run on Node with `WebAssembly.compile` of the emitted files |

So the canonical ABI's linear-memory requirement is met by a **generated glue module** beside the GC module, not by changing the GC module. What
this does not show: records, lists, variants and resources (only `string` was lifted and lowered); the cost of the copies; a platform running a
transpiled component (nothing here was deployed); wasmtime or another host running a GC core module inside a component.

```bash
wasm-tools parse glue.component.wat -o glue.component.wasm && wasm-tools validate glue.component.wasm
wasm-tools component wit glue.component.wasm
npx @bytecodealliance/jco@1.42.0 transpile glue.component.wasm -o out && echo '{"type":"module"}' > out/package.json
node -e 'import("./out/glue.component.js").then((m) => console.log(m.greet("Welt")))'
```

## Spike 2: no second module — the adapters inside the GC module, strings as UTF-16

The first spike put the linear memory in a second core module. It does not have to be: a WebAssembly GC module can have a linear memory too, and the
adapters of the canonical ABI (`cabi_realloc`, the lift of the arguments, the lower of the result, `cabi_post_<name>`) are ordinary functions of it.
`single-module.wat` is one module with GC types and its own memory; the string crosses with **`--encoding utf16`**, so the adapter copies UTF-16 code
units (fsharp-wasm's strings are arrays of them) and no UTF-8 transcoding is written at all:

```bash
wasm-tools parse single-module.wat -o one.wasm
wasm-tools component embed single-module.wit one.wasm --encoding utf16 -o one.emb.wasm
wasm-tools component new one.emb.wasm -o one.component.wasm            # 918 bytes
npx @bytecodealliance/jco@1.42.0 transpile one.component.wasm -o out   # Node 24: greet("Grüße ✓ 🚀 日本語") round-trips, emoji included
```

| what | result |
|---|---|
| `wasm-tools component embed --encoding utf16` + `component new` on that one module | a valid 918-byte component; `component wit` prints `export greet: func(name: string) -> string` |
| jco 1.42.0 on Node 24 | the strings round-trip, surrogate pairs included |
| memory | the allocator is a bump arena that grows the memory; `cabi_post_greet` resets it after the host has read the result |
| cost, string in and out, jco's JavaScript doing the transcoding, loops in the adapter | 4 characters: 10 µs a call; 1 KB: 0.17 ms; 64 KB: 2.1 ms; 2 MB: 49 ms |

What it means: bodies of a few KB cost tens to hundreds of microseconds a call at this boundary; megabytes cost tens of milliseconds, so large
payloads want `list<u8>` and a bulk path, not `string`. A linear memory and a GC array have no bulk copy between them (`array.new_data` /
`array.init_data` read a data segment, not the memory), so the adapter copies in a loop. Still not shown: records, lists of records, `option`,
`result`, resources; the same module on wasmtime; a platform running the transpiled component.

