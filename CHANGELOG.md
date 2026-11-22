# Changelog

All notable changes to this repository are documented here (newest first).

## [Unreleased]

### Added
- **The canvas client is served below `/canvas/` on every platform** (`fixtures/canvas`, `fixtures/GhostTodoCanvas.provenance.json`): the second client of the Ghost Todo, written in F# with the widgets of
  fsharp-wasm-graphics and compiled to WebAssembly GC (197 KB, with its page and the runtime it loads), built by `bash build/build.sh --module canvas` in fsharp-wasm-backend. The page of the first client links to it, and
  both are clients of one server: what one does, the other shows (checked in a browser in the backend's CI). The host core serves binary assets (`{ type, base64 }`, decoded once) and redirects
  (`/canvas` to `canvas/`, relative, so that it holds below a base path); `build/assets.mjs` takes the fixture into `host/runtime/assets.js`; `tools/fixture.mjs set-canvas` records it with the revisions of the source,
  the compiler, the base library, the widgets and the runtime, and `check` refuses a canvas module that imports the server's host binding. The matrix has three checks more: **29 checks, identical on all 8 platforms** (measured
  2026-11-22: Node, Bun, Deno, Netlify edge function, workerd through Miniflare, the Vercel Edge sandbox, the Vercel and Netlify function handlers).
- **The host moved here from fsharp-wasm-backend**: the core and the stores (`host/runtime`), the adapters for Node, Bun, Deno, Cloudflare Workers
  (with a Durable Object), Vercel and Netlify (`host/adapters`), the GGBP client (`host/client`), the packager (`build/`), the platform matrix
  and the live runner (`tests/platforms`), and the deploy workflow with its documentation.
- **A fixture** (`fixtures/GhostTodo.wasm` with `GhostTodo.provenance.json`): the module the tests run, with the revisions of the source, the
  compiler and the base library it was built from; `tools/fixture.mjs` records a new one and verifies the checked-in one (it also refuses a module
  that imports `wasm:js-string`).
- **CI**: actionlint, the matrix (the 26 checks, 29 now, on Node, Bun, Deno, workerd, the Vercel Edge Runtime sandbox, the Vercel and Netlify function
  handlers and Netlify's edge runtime; identical answers), and the platforms' own tools on the packages without an account (`wrangler deploy
  --dry-run`, `netlify build --offline`). The tools' versions are in `.github/tool-versions.env`, used by CI and by the deploy workflow.
