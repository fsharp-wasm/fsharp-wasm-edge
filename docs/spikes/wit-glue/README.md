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
