# fsharp-wasm-edge

<!-- status -->
[![CI](https://github.com/fsharp-wasm/fsharp-wasm-edge/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/fsharp-wasm/fsharp-wasm-edge/actions/workflows/ci.yml) [![Deploy](https://github.com/fsharp-wasm/fsharp-wasm-edge/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/fsharp-wasm/fsharp-wasm-edge/actions/workflows/deploy.yml) · [Status of every repository](https://fsharp-wasm.github.io/status/)
<!-- /status -->

<!-- platform -->
> **Part of the [fsharp-wasm platform](https://fsharp-wasm.github.io/projects/)**: server and edge. Runs modules compiled from any F# program; the first are those of [backend](https://github.com/fsharp-wasm/fsharp-wasm-backend). Used by the deployments, once there are any.
> [All projects](https://fsharp-wasm.github.io/projects/) · [Roadmap](https://fsharp-wasm.github.io/docs/roadmap/) · [Tests](https://fsharp-wasm.github.io/tests/) · [Benchmarks](https://fsharp-wasm.github.io/benchmarks/) · [Live demos](https://fsharp-wasm.github.io/demos/)

The host that runs **F# programs compiled to WebAssembly GC** on the platforms people deploy to: **Cloudflare Workers (with Durable Objects), Vercel,
Netlify, Deno, Bun and Node** — one module, a small adapter per platform, the same answers everywhere.

> **Status: nothing is deployed yet.** The host, the adapters and the tests work and run in CI; the deploy workflow is written and checked as far as it can
> be without an account ([docs/deploy.md](docs/deploy.md) says what it needs and what each row of "verified" means). The first real deployments are
> next on the [roadmap](docs/roadmap.md).

```text
F# module  ──fsharp-wasm──▶  GhostTodo.wasm   (47 KB, WebAssembly GC, string ABI: exports)
                                  │  handle()   reads the request, writes the response, one at a time
   host/runtime/server.js  (the core: Request ⇄ module, store, strings)   ← web-standard Request / Response
       ├─ adapters/node        http.createServer                     ├─ adapters/cloudflare  Worker + Durable Object
       ├─ adapters/bun         Bun.serve                              ├─ adapters/vercel      Edge + Node functions
       └─ adapters/deno        Deno.serve + Deno KV                   └─ adapters/netlify     Edge function + Function
```

The modules are written in [fsharp-wasm-backend](https://github.com/fsharp-wasm/fsharp-wasm-backend) (the demo is **Ghost Todo**: a todo list whose
every change is a GGBP patch that a client applies to a shadow). This repository is where they **run**: a module should not need to know whether it is
served from a Worker, a Vercel function or a Deno process, and a platform adapter should not need the compiler to be tested.

## What is verified

`npm ci && node build/package.mjs && node tests/platforms/run.mjs` runs **the same 29 checks on every platform** and compares what the platforms answer:
identical answers in 20 steps (unicode text, the patches decoded and applied to a shadow, 12 parallel requests, a log of 64 patches that rolls over,
404 / 405 / 400, CORS, the page, and the canvas client below `/canvas/`: its page, its WebAssembly module and its runtime). Where a platform has storage, the state survives a restart.

| platform | what runs here | how real | state |
|---|---|---|---|
| Node 24 | the packaged adapter, as a process | the platform's own runtime | a JSON file, survives a restart |
| Bun 1.4 | the packaged adapter, as a process | the platform's own runtime | a JSON file, survives a restart |
| Deno 2.9 / Deno Deploy | the packaged adapter, as a process | the platform's own runtime | Deno KV, survives a restart |
| Cloudflare Workers | the Worker and the Durable Object on **workerd** (through Miniflare) | the platform's runtime and its Durable Object storage; **not deployed** | Durable Object storage, survives a restart |
| Vercel Edge Functions | the edge adapter, bundled with `?module` as a ready `WebAssembly.Module`, in the Edge Runtime sandbox (`@edge-runtime/vm`) | an emulation; Vercel's bundler and platform are not exercised; **not deployed** | memory per instance |
| Vercel Functions (Node) | the Node adapter's handlers (mounted at `/api/node`), called in a Node 24 process | the handler contract; **not deployed** | memory per instance |
| Netlify Edge Functions | the edge adapter under Deno, given a `Request` | Netlify's edge runtime is Deno; Netlify's bundler is not exercised by the matrix; **not deployed** | memory per instance |
| Netlify Functions | the function's handler, called in a Node 24 process | the handler contract; **not deployed** | memory per instance |

Beyond the matrix, CI runs what the platforms' own tools say about the packages, without an account: `wrangler deploy --dry-run` for Cloudflare and
`netlify build --offline` for Netlify (Vercel's CLI wants a token even for a local build, so that row is not checked).

Not supported: **Fastly Compute, Fermyon Spin, WasmEdge** run WASI *components*, not a module with a JavaScript host. Components (WIT worlds, linked by a
small host) are the plan for those and for a cleaner contract; see the [roadmap](docs/roadmap.md).

## Why the string ABI is "exports"

The compiler's default lets a string cross the module boundary through the JS String Builtins (`wasm:js-string`). A platform that hands the module over
**precompiled** — Cloudflare Workers and Vercel Edge import a `.wasm` as a ready `WebAssembly.Module` — compiles it without those builtins, and
instantiating fails (`Import "wasm:js-string": module is not an object or function`; checked in workerd). So these modules are built with
`WASMGC_STRING_ABI=exports`: no `wasm:js-string` import at all, strings read and built through four exports of the module. It works on every engine
with WebAssembly GC. `tools/fixture.mjs` refuses a module that imports the builtins.

## Layout

| path | what it is |
|---|---|
| `host/runtime` | the core (`server.js`), the stores (`stores.js`: memory, JSON file, Deno KV, Durable Object storage), the generated assets |
| `host/adapters` | the platform adapters, each a few lines over the core, and their configuration (`wrangler.toml`, `vercel.json`, `netlify.toml`, `deno.json`) |
| `host/client` | the GGBP client (`ggbp.js`) and the page that keeps a shadow (the first client, JavaScript and the DOM) |
| `build/` | `package.mjs` lays out `dist/platforms/<name>/` for each platform from a module; `assets.mjs` generates the page |
| `fixtures/` | `GhostTodo.wasm` and `GhostTodo.provenance.json`: the module the tests run, with the revisions of the source, the compiler and the base library it was built from. `canvas/` and `GhostTodoCanvas.provenance.json`: the second client of the same API, written in F# with widgets and drawn onto a canvas (page, module, runtime), served by every platform at `/canvas/`; built from fsharp-wasm-backend (`bash build/build.sh --module canvas`) |
| `bench/` | the benchmark: the module against hand-written JavaScript and Hono on Node, Bun and workerd, with the numbers and what they mean ([bench/README.md](bench/README.md)) |
| `tests/platforms` | the matrix (`run.mjs`) and the live runner (`live.mjs`: the same checks against deployments) |
| `tools/fixture.mjs` | `set` records a new module with its provenance, `set-canvas` the canvas client, `check` verifies the checked-in ones (the canvas client must not import the host binding of the server) |
| `.github/workflows` | `ci.yml` (lint, matrix, package checks), `deploy.yml` (the CI artifact to Cloudflare, Vercel and Netlify, then the live check) |
| `docs/` | [deploy.md](docs/deploy.md), [platforms.md](docs/platforms.md), [roadmap.md](docs/roadmap.md), [spikes/wit-glue](docs/spikes/wit-glue/README.md) (a WasmGC module as a WIT component) |

## Build and run

```bash
npm ci
node build/package.mjs                       # dist/platforms/{node,bun,deno,cloudflare,vercel,netlify} from fixtures/GhostTodo.wasm
node dist/platforms/node/index.mjs           # http://localhost:8787/
node tests/platforms/run.mjs                 # the matrix; optionally: node bun deno netlify-edge cloudflare vercel-edge vercel-node netlify-functions
GHOST_WASM=/path/to/Other.wasm node build/package.mjs    # package another module
```

The matrix needs Node 24, `deno` and `bun` on the PATH (or `TOOLS_BIN` for `deno`).

## What a module cannot do

A module is **synchronous**: it cannot wait for a network call (no JSPI yet), so the core reads the request body and loads the store before the call and
flushes the store after it. State that outlives a request lives in the module's memory and is persisted through the store; an instance serves requests
one at a time. On Cloudflare a Durable Object per room is exactly that. On Vercel and Netlify an instance forgets between cold starts and instances do
not share memory: the memory store is what those platforms give; for state that outlives an instance, put a store of `host/runtime/stores.js` over
Vercel KV / Blob or Netlify Blobs (not written: nothing here can test it).

## Principles

- **Say what is real.** Every platform is listed as a runtime, an emulation or deployed — and nothing is called deployed until a URL answers.
- **Same answers everywhere.** A platform that answers differently is a finding, not a configuration.
- **Accessible by default.** The GUI layer to come renders semantic HTML; WebAssembly computes, the page stays readable by people and assistive technology.
- **Our own libraries.** Few dependencies, each one pinned.

## Contributing

Welcome. [CONTRIBUTING](https://github.com/fsharp-wasm/.github/blob/develop/CONTRIBUTING.md) is the organisation's guide and [AGENTS.md](AGENTS.md) says how the platform is worked on (the compiler comes first: a fault found here
is fixed in the compiler, not worked around here).

- **Run the tests:** `npm ci && node build/package.mjs && node tests/platforms/run.mjs` (the same checks on every platform).
- **A good first contribution:** A platform adapter that is an emulation and could be a runtime, or a check the matrix lacks. Issues labelled [`good first issue`](https://github.com/fsharp-wasm/fsharp-wasm-edge/labels/good%20first%20issue) are the places to start.
- **A change** goes to `develop` as a pull request, with a test that fails without it. Open an issue first for anything larger than a fix.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The host core, the adapters, the matrix and the deploy workflow were written in
fsharp-wasm-backend and moved here.
