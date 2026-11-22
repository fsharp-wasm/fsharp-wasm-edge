# Benchmarks: the Ghost Todo on the runtimes of the edge

Measured on **2026-11-22**, on one machine (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, shared), **in-process and local**: what is timed is a request handled by the application
(`fetch(request) → response`), without a network, without a platform in front, without the machine of any provider. It says what the module and the framework cost per request on the
engine of each platform; it does **not** say what a request costs a user of Cloudflare, Vercel or Netlify (that needs deployments, which wait for a go, see `docs/deploy.md`).

## What is compared

The same API (`demos/ghost-todo` of fsharp-wasm-backend: state, add, toggle, delete, patches since a version, with a GGBP patch for every change; a change is persisted as its patch under `log/<version>`, and every 64 versions the module folds the log into a checkpoint after the response: the `idle` call of the host) as

- **F# → WasmGC**: `fixtures/GhostTodo.wasm` (the F# module, compiled by fsharp-wasm) run by the host core `host/runtime/server.js`, the way every platform adapter runs it. Its strings cross the module's boundary in the *Exports ABI*, because Cloudflare and Vercel Edge cannot give a module the JS String Builtins: since fsharp-wasm `e8a281a` (2026-11-22) a whole string moves through a linear memory the module exports (two calls and one typed-array view); before, it crossed one character per call (the column *before* below).
- **JavaScript (hand-written)**: a router of a few lines around `bench/logic.mjs`.
- **JavaScript (Hono)**: the framework most edge applications use, around the same `bench/logic.mjs`.

`bench/logic.mjs` is the model, the GGBP encoding and the persistence in JavaScript, **the same program** as the F# one. Before anything is timed, `bench/equivalence.mjs` sends 18 requests (good ones, bad ones, unicode,
unknown ids, a missing `since`) to all three and compares status and body: it found two differences in the first version of the JavaScript (a missing `since` was read as 0, a broken body had another message); the numbers below are of
implementations that answer identically.

## Results

### Node 22.23.4  (`node bench/run.mjs`)

Median per request (p95, p99 and the mean are in `bench/results/*-log.json`). `F# ÷ JS` is how many times the module needs what the hand-written JavaScript of the same run needs. *Snapshot* is the module of the run before (`*-bulk.json`, the same day), which persisted the whole list after every change; the JavaScript of that run did the same, so its numbers are not in the table.

| scenario | F# → WasmGC | JavaScript | Hono | F# ÷ JS | F# with a snapshot |
|---|---:|---:|---:|---:|---:|
| poll, nothing new | 9.4 µs | 5.4 µs | 5.1 µs | 1.7× | 9.6 µs |
| state, 100 todos | 56.1 µs | 14.5 µs | 14.1 µs | 3.9× | 88.3 µs |
| state, 5 000 todos | 7.47 ms | 593 µs | 596 µs | 12.6× | 6.81 ms |
| toggle, 100 todos | 17.9 µs | 8.6 µs | 9.3 µs | 2.1× | 175 µs |
| toggle, 5 000 todos | 49.6 µs | 31.0 µs | 32.2 µs | 1.6× | 9.78 ms |
| add + remove, 100 todos | 30.9 µs | 14.7 µs | 14.0 µs | 2.1× | 185 µs |

### Bun 1.4.4  (`bun bench/run.mjs`)

| scenario | F# → WasmGC | JavaScript | Hono | F# ÷ JS | F# with a snapshot |
|---|---:|---:|---:|---:|---:|
| poll, nothing new | 7.4 µs | 2.0 µs | 1.7 µs | 3.6× | 7.5 µs |
| state, 100 todos | 85.9 µs | 5.4 µs | 5.4 µs | 16.1× | 89.8 µs |
| state, 5 000 todos | 6.87 ms | 313 µs | 312 µs | 21.9× | 7.11 ms |
| toggle, 100 todos | 17.0 µs | 6.7 µs | 7.2 µs | 2.5× | 270 µs |
| toggle, 5 000 todos | 95.1 µs | 32.7 µs | 34.1 µs | 2.9× | 8.07 ms |
| add + remove, 100 todos | 20.2 µs | 9.1 µs | 8.1 µs | 2.2× | 314 µs |

### workerd, the engine of Cloudflare Workers, through Miniflare  (`node bench/workerd.mjs`)

workerd freezes the clock inside a Worker while it only computes, so a batch of calls is timed from outside: these are **means**, not medians.

| scenario | F# → WasmGC | JavaScript | Hono | F# ÷ JS | F# with a snapshot |
|---|---:|---:|---:|---:|---:|
| poll, nothing new | 24.9 µs | 13.5 µs | 13.3 µs | 1.8× | 22.4 µs |
| state, 100 todos | 74.6 µs | 17.9 µs | 16.6 µs | 4.2× | 61.6 µs |
| state, 5 000 todos | 3.47 ms | 515 µs | 612 µs | 6.7× | 3.62 ms |
| toggle, 100 todos | 36.9 µs | 15.6 µs | 27.9 µs | 2.4× | 195 µs |
| toggle, 5 000 todos | 117 µs | 113 µs | 86.1 µs | 1.0× | 4.62 ms |
| add + remove, 100 todos | 63.1 µs | 27.0 µs | 33.2 µs | 2.3× | 230 µs |

### What is shipped (`node bench/size.mjs`)

| deployed code | minified | gzip |
|---|---:|---:|
| F# → WasmGC: the module | 58.4 KB | 23.5 KB |
| F# → WasmGC: the module and the host core | 63.0 KB | 25.7 KB |
| JavaScript (hand-written) | 7.0 KB | 2.8 KB |
| JavaScript (Hono) | 26.6 KB | 10.7 KB |

Cold start of the module: compiling it takes 0.66 ms on Node 22 and 1.4 ms on Bun (which compiles eagerly); instantiating it and the first request are part of the first call of each scenario. The JavaScript variants have no comparable step in-process, so no cold-start comparison is made here.

## What it shows

- **A change no longer writes the whole list.** Until 2026-11-22 (second run) the module persisted the whole state after every change, so a toggle in a list of 5 000 cost nearly what the state costs. Now a change persists its patch, at most 58 characters
  (`tests/host/persistence.mjs`; the state of 5 000 todos is 218 000), and the checkpoint is written after the response. A toggle in 5 000 todos: **9.78 ms to 49.6 µs** on Node, 8.07 ms to 95 µs on Bun, 4.62 ms to 117 µs on workerd; in 100 todos 175 µs to 17.9 µs
  on Node. The JavaScript of the benchmark persists the same way (it needed 1.14 ms for that toggle before), so the ratio compares the module and the language, not two ways of persisting.
- **That puts the module close to the hand-written JavaScript on everything that changes or polls**: 1.6 to 2.9 times for a toggle in 5 000 todos (1.0 on workerd, by mean), 2.1 to 2.5 times in 100 todos, 1.7 times (Node) on a poll with nothing new.
- **Where the answer is a long string it is still far behind**: the state of 5 000 todos is 12.6 times (Node), 21.9 times (Bun) and 6.7 times (workerd) the JavaScript. That is compiled code, not the string boundary (the bulk path took that
  in the run before): the JSON writer builds a tree first, then the text (profile in `docs/STATUS.md` of fsharp-wasm).
- **The checkpoint is a spike, off the response**: every 64th version the module writes one (the JSON of the whole list, 7 ms for 5 000 todos). In this in-process loop the request after it waits behind it: the p99 of a toggle in 5 000 todos is 7.0 ms on Node
  (the JavaScript, which writes the checkpoint at once, 0.71 ms), the mean 197 µs (JavaScript 52 µs). A deployment runs it after the response; a request that arrives while it runs waits for it.
- **Not in these numbers**: the time of a real write. The store of the benchmark is memory; the bytes per request are the difference that remains when the store is a Durable Object, Deno KV or a file (a journal since 2026-11-22: a request appends a line instead of
  rewriting the file).
- The module is 8.5 times the size of the hand-written JavaScript and 2.2 times the size of a Hono bundle (gzip, 24.0 KB against 2.8 and 10.9). The module grew by 10 KB when it learned to replay its log (the decoder and the transition of the clients are in it now);
  the JavaScript grew by 3 KB for the same. What the module buys is not speed or size: it is one language and the same code on the server and in the client (the model and the shadow of `GhostTodoCore` run in `GhostTodo.wasm` and in the canvas client), and a type checker for both.

## Reproduce

```bash
npm ci
node bench/run.mjs --budget 1000 --json bench/results/<date>-node.json     # or: bun bench/run.mjs …
node bench/workerd.mjs --json bench/results/<date>-workerd.json
node bench/size.mjs
```

`--budget` is the milliseconds each scenario runs for. A module other than the fixture: `--wasm path/to/GhostTodo.wasm`. Numbers vary by some percent from run to run and by a lot between machines; compare the ratios.
