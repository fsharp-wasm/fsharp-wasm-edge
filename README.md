# fsharp-wasm-edge

The host that runs **F# programs compiled to WebAssembly GC** on the platforms people deploy to: **Cloudflare Workers (with Durable Objects), Vercel,
Netlify, Deno, Bun and Node** — one module, a small adapter per platform, the same answers everywhere.

> **Status: just started.** The code this repository is for exists and works, but it still lives in
> [fsharp-wasm-backend](https://github.com/fsharp-wasm/fsharp-wasm-backend) (`server/`, `tests/platforms`, the deploy workflow) and is moving here.
> Nothing is deployed to a platform yet. [docs/roadmap.md](docs/roadmap.md) has the order and the reasons.

## What it will contain

```text
host/         the core (Request ⇄ module, one request at a time, a store loaded before and flushed after a call) and the adapters
wit/          the WIT worlds a module implements — `ghost` first, then the generic `handler`
dsl/          a typed F# DSL for the host (routes, stores, platform settings), usable from Fable projects
fixtures/     the compiled modules the tests run, with the revision of the compiler and the source they came from
tests/        the platform matrix (the same 26 checks everywhere, answers compared) and the live runner (the same checks against deployments)
docs/         how to deploy, what each platform needs, the roadmap
```

## Why a separate repository

[fsharp-wasm-backend](https://github.com/fsharp-wasm/fsharp-wasm-backend) is where backend **modules** are written (F#, compiled by
[fsharp-wasm](https://github.com/fsharp-wasm/fsharp-wasm)); this repository is where they **run**. A module should not need to know whether it is
served from a Worker, a Vercel function or a Deno process, and a platform adapter should not need the compiler to be tested.

## Principles

- **Say what is real.** Every platform is listed as a runtime, an emulation or deployed — and nothing is called deployed until a URL answers.
- **Same answers everywhere.** A platform that answers differently is a finding, not a configuration.
- **Accessible by default.** The GUI layer to come renders semantic HTML; WebAssembly computes, the page stays readable by people and assistive technology.
- **Our own libraries.** Few dependencies, each one pinned.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
