# Roadmap

Ordered by one rule: **what is proven runs first; new technology comes after the thing it builds on works.** Dates are not promised.

| # | what | why this place | needs |
|---|---|---|---|
| 0 | The org site and the organisation profile are live and say what is measured and what is planned | costs nothing, visible at once | done |
| 1 | **Foundation here** — *done*: the host core, the adapters, the platform matrix, the live runner and the deploy workflow move from fsharp-wasm-backend; the matrix runs on a fixture (`GhostTodo.wasm` with the revision of compiler and source) | one place to look; the backend keeps the F# modules and the .NET reference libraries | — |
| 2 | **First real deployments**: Cloudflare first (Durable Object = consistent state), then Vercel and Netlify; the 26 checks run against the live URLs; the URLs go on the site and in the READMEs | a public *Ghost Todo* that anyone can open is the strongest proof and the best marketing; it also answers whether the production runtimes accept a WasmGC module | accounts and secrets ([deploy.md](https://github.com/fsharp-wasm/fsharp-wasm-backend/blob/main/docs/deploy.md) in the backend repository until it moves here) |
| 3 | **WIT components**: the `ghost` world first (it is the special one: patches and a shadow), the generic `handler` world next (`include`d by `ghost`, needed by every other module); the compiler generates the linear-memory glue; the host links them with jco | the spike showed it works for `string`; records, lists, variants and the cost are open | compiler work in fsharp-wasm |
| 4 | **A typed F# DSL** for the host: routes, stores, platform settings; usable from Fable | the host exists and is tested, so the DSL has something to describe | 1–3 |
| 5 | **A GUI framework that renders accessible HTML** (semantic elements, keyboard, ARIA), themeable with Pico CSS; Ghost Todo's UI is the first app; accessibility checks in CI | the page has to be readable by everyone; it comes last because it sits on the DSL | 4 |

Not everything can be WebAssembly: canvas graphics stay where they belong (drawing, editors); what people read and operate is HTML.
