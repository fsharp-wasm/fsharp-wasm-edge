# Benchmarks: the Ghost Todo on the runtimes of the edge

Measured on **2026-11-22**, on one machine (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, shared), **in-process and local**: what is timed is a request handled by the application
(`fetch(request) → response`), without a network, without a platform in front, without the machine of any provider. It says what the module and the framework cost per request on the
engine of each platform; it does **not** say what a request costs a user of Cloudflare, Vercel or Netlify (that needs deployments, which wait for a go, see `docs/deploy.md`).

## What is compared

The same API (`demos/ghost-todo` of fsharp-wasm-backend: state, add, toggle, delete, patches since a version, with a GGBP patch for every change and the state persisted whole in a store after every change) as

- **F# → WasmGC**: `fixtures/GhostTodo.wasm` (the F# module, compiled by fsharp-wasm) run by the host core `host/runtime/server.js`, the way every platform adapter runs it. Its strings cross the module's boundary in the *Exports ABI*, because Cloudflare and Vercel Edge cannot give a module the JS String Builtins: since fsharp-wasm `e8a281a` (2026-11-22) a whole string moves through a linear memory the module exports (two calls and one typed-array view); before, it crossed one character per call (the column *before* below).
- **JavaScript (hand-written)**: a router of a few lines around `bench/logic.mjs`.
- **JavaScript (Hono)**: the framework most edge applications use, around the same `bench/logic.mjs`.

`bench/logic.mjs` is the model, the GGBP encoding and the persistence in JavaScript, **the same program** as the F# one. Before anything is timed, `bench/equivalence.mjs` sends 18 requests (good ones, bad ones, unicode,
unknown ids, a missing `since`) to all three and compares status and body: it found two differences in the first version of the JavaScript (a missing `since` was read as 0, a broken body had another message); the numbers below are of
implementations that answer identically.

## Results

### Node 22.23.4  (`node bench/run.mjs`)

Median per request (p95 and p99 are in `bench/results/*.json`). `F# ÷ JS` is how many times the module needs what the hand-written JavaScript of the same run needs; `before` is the module with the per-character string path, measured in an earlier run of the same day (the machine is shared: compare the ratios, and read the absolute numbers of two runs with some caution).

| scenario | F# → WasmGC | before | JavaScript | Hono | F# ÷ JS |
|---|---:|---:|---:|---:|---:|
| poll, nothing new | 9.6 µs | 20.1 µs | 5.4 µs | 6.0 µs | 1.8× |
| state, 100 todos | 88.3 µs | 392 µs | 14.3 µs | 14.1 µs | 6.2× |
| state, 5 000 todos | 6.81 ms | 20.37 ms | 613 µs | 618 µs | 11.1× |
| toggle, 100 todos | 175 µs | 614 µs | 25.8 µs | 27.6 µs | 6.8× |
| toggle, 5 000 todos | 9.78 ms | 20.53 ms | 1.14 ms | 661 µs | 8.6× |
| add + remove, 100 todos | 185 µs | 995 µs | 43.0 µs | 35.7 µs | 4.3× |

### Bun 1.4.4  (`bun bench/run.mjs`)

| scenario | F# → WasmGC | before | JavaScript | Hono | F# ÷ JS |
|---|---:|---:|---:|---:|---:|
| poll, nothing new | 7.5 µs | 33.5 µs | 2.7 µs | 1.9 µs | 2.8× |
| state, 100 todos | 89.8 µs | 765 µs | 9.1 µs | 7.9 µs | 9.9× |
| state, 5 000 todos | 7.11 ms | 43.19 ms | 314 µs | 405 µs | 22.7× |
| toggle, 100 todos | 270 µs | 1.62 ms | 28.7 µs | 20.4 µs | 9.4× |
| toggle, 5 000 todos | 8.07 ms | 40.33 ms | 574 µs | 321 µs | 14.1× |
| add + remove, 100 todos | 314 µs | 1.72 ms | 28.0 µs | 30.4 µs | 11.2× |

### workerd, the engine of Cloudflare Workers, through Miniflare  (`node bench/workerd.mjs`)

workerd freezes the clock inside a Worker while it only computes, so a batch of calls is timed from outside: these are **means**, not medians.

| scenario | F# → WasmGC | before | JavaScript | Hono | F# ÷ JS |
|---|---:|---:|---:|---:|---:|
| poll, nothing new | 22.4 µs | 41.8 µs | 14.3 µs | 8.6 µs | 1.6× |
| state, 100 todos | 61.6 µs | 296 µs | 35.1 µs | 28.7 µs | 1.8× |
| state, 5 000 todos | 3.62 ms | 8.54 ms | 528 µs | 491 µs | 6.8× |
| toggle, 100 todos | 195 µs | 557 µs | 26.6 µs | 28.3 µs | 7.3× |
| toggle, 5 000 todos | 4.62 ms | 11.25 ms | 571 µs | 653 µs | 8.1× |
| add + remove, 100 todos | 230 µs | 569 µs | 39.5 µs | 38.3 µs | 5.8× |

### What is shipped (`node bench/size.mjs`)

| deployed code | minified | gzip |
|---|---:|---:|
| F# → WasmGC: the module | 48.5 KB | 19.4 KB |
| F# → WasmGC: the module and the host core | 52.8 KB | 21.4 KB |
| JavaScript (hand-written) | 4.1 KB | 1.8 KB |
| JavaScript (Hono) | 23.6 KB | 9.7 KB |

Cold start of the module: compiling it takes 0.73 ms on Node 22 and 1.2 ms on Bun (which compiles eagerly); instantiating it and the first request are part of the first call of each scenario. The JavaScript variants have no comparable step in-process, so no cold-start comparison is made here.

## What it shows

- **The bulk string path made the module 2 to 5 times faster on Node, 4.5 to 8.5 times on Bun and 1.9 to 4.8 times on workerd** (the *before* column, the same module with the per-character path; the least gain is on the request that moves almost no string). The cause had been measured before the change: a CPU profile of the 5 000-todo state on Node (`--cpu-prof`) put 42.5 % of the time in the JavaScript-to-WebAssembly trampolines, one call per character.
- **A poll that has nothing to report is close to the hand-written JavaScript**: 1.8 times on Node, 1.6 times on workerd, 2.8 times on Bun. That is the request every open client makes once a second.
- **Where the answer or the persisted snapshot is long it is still behind**: 4 to 11 times on Node, 2 to 8 times on workerd, 9 to 23 times on Bun (the state of 5 000 todos is 218 000 characters of JSON). The two requests that cost most are the state of 5 000 todos and a `toggle` in a list of 5 000, and they cost about the same: every change persists the whole state as a string, so a patch of a few dozen bytes to the clients still comes with a snapshot of the whole list to the store. That is a property of how this demo persists, not of the string path.
- **What is left is in the compiled code, not at the boundary.** A profile after the bulk path (recorded in `docs/STATUS.md` of fsharp-wasm, 2026-11-22): 29.5 % garbage collection, 37 % writing the JSON (the whole tree of 5 000 todos is built first, then written), 8.8 % the snapshot, 5.9 % `StringBuilder.Append`; our strings are arrays of 4-byte characters. Next to try there: a JSON writer without the tree, a builder that grows by doubling, strings of 2-byte characters. Not measured here: the JS String Builtins ABI, which Cloudflare Workers and Vercel Edge do not offer (and Node 22 does not either).
- The module is 11 times the size of the hand-written JavaScript and 2 times the size of a Hono bundle (gzip); the bulk exports added 2.5 KB. What the module buys is not speed or size: it is one language and the same code on the server and in the client (the model and the shadow of `GhostTodoCore` run in `GhostTodo.wasm` and in the canvas client), and a type checker for both.

## Reproduce

```bash
npm ci
node bench/run.mjs --budget 1000 --json bench/results/<date>-node.json     # or: bun bench/run.mjs …
node bench/workerd.mjs --json bench/results/<date>-workerd.json
node bench/size.mjs
```

`--budget` is the milliseconds each scenario runs for. A module other than the fixture: `--wasm path/to/GhostTodo.wasm`. Numbers vary by some percent from run to run and by a lot between machines; compare the ratios.
