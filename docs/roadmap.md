# Roadmap

Ordered by one rule: **what is proven runs first; new technology comes after the thing it builds on works.** Dates are not promised.

| # | what | why this place | needs |
|---|---|---|---|
| 0 | The org site and the organisation profile are live and say what is measured and what is planned | costs nothing, visible at once | done |
| 1 | **Foundation here** — *done*: the host core, the adapters, the platform matrix, the live runner and the deploy workflow move from fsharp-wasm-backend; the matrix runs on a fixture (`GhostTodo.wasm` with the revision of compiler and source) | one place to look; the backend keeps the F# modules and the .NET reference libraries | — |
| 2 | **First real deployments** — *Cloudflare done, 2026-11-27*: Ghost Todo is live on Cloudflare Workers with a Durable Object and passes the 29 checks against the address; Vercel and Netlify are deployed and answer the page, their API waits for the Upstash Redis (`503` until then). Open: the Redis variables in both projects, then the 29 checks against their live URLs | a public *Ghost Todo* that anyone can open is the strongest proof and the best marketing; it also answers whether the production runtimes accept a WasmGC module: Cloudflare's does, the other two are decided by that run | the Redis and its variables in the Vercel and Netlify projects (set by the maintainer; [deploy.md](deploy.md)) |
| 3 | **WIT components**: the `ghost` world first (it is the special one: patches and a shadow), the generic `handler` world next (`include`d by `ghost`, needed by every other module); the compiler emits the canonical-ABI adapters *into the module itself* (a linear memory beside the GC types, `cabi_realloc`, lift and lower per export, `--encoding utf16` so no transcoding); the host links the components with jco | [the spike](spikes/wit-glue/README.md) showed it works for `string`; records, lists, variants and the cost are open | compiler work in fsharp-wasm |
| 4 | **A typed F# DSL** for the host: routes, stores, platform settings; usable from Fable | the host exists and is tested, so the DSL has something to describe | 1–3 |
| 5 | **A GUI framework that renders accessible HTML** (semantic elements, keyboard, ARIA), themeable with Pico CSS; Ghost Todo's UI is the first app; accessibility checks in CI | the page has to be readable by everyone; it comes last because it sits on the DSL | 4 |

Not everything can be WebAssembly: canvas graphics stay where they belong (drawing, editors); what people read and operate is HTML.
