# Benchmarks: the Ghost Todo on the runtimes of the edge

Measured on **2026-11-22**, on one machine (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, shared), **in-process and local**: what is timed is a request handled by the application
(`fetch(request) → response`), without a network, without a platform in front, without the machine of any provider. It says what the module and the framework cost per request on the
engine of each platform; it does **not** say what a request costs a user of Cloudflare, Vercel or Netlify (that needs deployments, which wait for a go, see `docs/deploy.md`).

## What is compared

The same API (`demos/ghost-todo` of fsharp-wasm-backend: state, add, toggle, delete, patches since a version, with a GGBP patch for every change and the state persisted whole in a store after every change) as

- **F# → WasmGC**: `fixtures/GhostTodo.wasm` (the F# module, compiled by fsharp-wasm) run by the host core `host/runtime/server.js`, the way every platform adapter runs it. Its strings cross the module's boundary in the *Exports ABI* (one call per character), because Cloudflare and Vercel Edge cannot give a module the JS String Builtins.
- **JavaScript (hand-written)**: a router of a few lines around `bench/logic.mjs`.
- **JavaScript (Hono)**: the framework most edge applications use, around the same `bench/logic.mjs`.

`bench/logic.mjs` is the model, the GGBP encoding and the persistence in JavaScript, **the same program** as the F# one. Before anything is timed, `bench/equivalence.mjs` sends 18 requests (good ones, bad ones, unicode,
unknown ids, a missing `since`) to all three and compares status and body: it found two differences in the first version of the JavaScript (a missing `since` was read as 0, a broken body had another message); the numbers below are of
implementations that answer identically.

## Results

Median per request (p95 and p99 are in `bench/results/*.json`). `F# ÷ JavaScript` is how many times the module needs what the hand-written JavaScript needs.

### Node 22.23.4  (`node bench/run.mjs`)

| scenario | F# → WasmGC | JavaScript | Hono | F# ÷ JavaScript |
|---|---:|---:|---:|---:|
| poll, nothing new | 20.1 µs | 12.1 µs | 10.4 µs | 1.7× |
| state, 100 todos | 392.1 µs | 27.4 µs | 21.4 µs | 14.3× |
| state, 5 000 todos | 20.37 ms | 1.18 ms | 675.5 µs | 17.2× |
| toggle, 100 todos | 613.6 µs | 32.5 µs | 50.6 µs | 18.9× |
| toggle, 5 000 todos | 20.53 ms | 842.9 µs | 1.29 ms | 24.4× |
| add + remove, 100 todos | 994.9 µs | 56.2 µs | 50.0 µs | 17.7× |

### Bun 1.4.4  (`bun bench/run.mjs`)

| scenario | F# → WasmGC | JavaScript | Hono | F# ÷ JavaScript |
|---|---:|---:|---:|---:|
| poll, nothing new | 33.5 µs | 3.2 µs | 2.7 µs | 10.4× |
| state, 100 todos | 765.5 µs | 10.8 µs | 9.5 µs | 70.8× |
| state, 5 000 todos | 43.19 ms | 578.4 µs | 509.0 µs | 74.7× |
| toggle, 100 todos | 1.62 ms | 36.5 µs | 24.7 µs | 44.3× |
| toggle, 5 000 todos | 40.33 ms | 601.9 µs | 339.5 µs | 67.0× |
| add + remove, 100 todos | 1.72 ms | 24.5 µs | 24.6 µs | 70.1× |

### workerd, the engine of Cloudflare Workers, through Miniflare  (`node bench/workerd.mjs`)

workerd freezes the clock inside a Worker while it only computes, so a batch of calls is timed from outside: these are **means**, not medians.

| scenario | F# → WasmGC | JavaScript | Hono | F# ÷ JavaScript |
|---|---:|---:|---:|---:|
| poll, nothing new | 41.8 µs | 17.7 µs | 14.5 µs | 2.4× |
| state, 100 todos | 295.8 µs | 32.4 µs | 28.7 µs | 9.1× |
| state, 5 000 todos | 8.54 ms | 776.1 µs | 667.9 µs | 11.0× |
| toggle, 100 todos | 556.7 µs | 34.1 µs | 34.8 µs | 16.3× |
| toggle, 5 000 todos | 11.25 ms | 694.2 µs | 600.2 µs | 16.2× |
| add + remove, 100 todos | 568.7 µs | 53.0 µs | 54.0 µs | 10.7× |

### What is shipped (`node bench/size.mjs`)

| deployed code | minified | gzip |
|---|---:|---:|
| F# → WasmGC: the module | 46.0 KB | 18.7 KB |
| F# → WasmGC: the module and the host core | 49.8 KB | 20.6 KB |
| JavaScript (hand-written) | 4.1 KB | 1.8 KB |
| JavaScript (Hono) | 23.6 KB | 9.7 KB |

Cold start of the module: compiling it takes 0.57 ms on Node 22 and 2 ms on Bun (which compiles eagerly); instantiating it and the first request are part of the first call of each scenario. The JavaScript variants have no comparable step in-process, so no cold-start comparison is made here.

## What it shows

- **On a poll that has nothing to report the gap is smallest**: 1.7× the hand-written JavaScript on Node, 2.4× on workerd, 10.4× on Bun. That is the request every open client makes once a second.
- **Wherever the answer or the persisted snapshot is long, it is far behind**: 14 to 24 times on Node and 9 to 16 times on workerd, 44 to 75 times on Bun (the state of 5 000 todos is 218 000 characters of JSON; every change persists the whole state as a string, which is why even a 100-todo `toggle` is slow).
- **The cause is the string boundary, measured.** A CPU profile of the 5 000-todo state on Node (`--cpu-prof`) puts **42.5 %** of the time in the JavaScript-to-WebAssembly trampolines (one call per character of the response, `__str_at`, and per character of the snapshot written to the store), 15.7 % in garbage collection and about a quarter in the module's own code (writing the JSON, the snapshot). A module compiled for the JS String Builtins crosses a string with one call, but Cloudflare Workers and Vercel Edge do not give a module the builtins (that is why the backend modules are built for the Exports ABI), and Node 22, which is what runs here, has no builtins either: **the other ABI is not measured here.**
- It is the first thing to improve, in the compiler and the host contract (a bulk path for the Exports ABI), not in the application: see `docs/STATUS.md` of fsharp-wasm.
- The module is 11 times the size of the hand-written JavaScript and 2 times the size of a Hono bundle (gzip). What the module buys is not speed or size: it is one language and the same code on the server and in the client (the model and the shadow of `GhostTodoCore` run in `GhostTodo.wasm` and in the canvas client), and a type checker for both.

## Reproduce

```bash
npm ci
node bench/run.mjs --budget 1000 --json bench/results/<date>-node.json     # or: bun bench/run.mjs …
node bench/workerd.mjs --json bench/results/<date>-workerd.json
node bench/size.mjs
```

`--budget` is the milliseconds each scenario runs for. A module other than the fixture: `--wasm path/to/GhostTodo.wasm`. Numbers vary by some percent from run to run and by a lot between machines; compare the ratios.
