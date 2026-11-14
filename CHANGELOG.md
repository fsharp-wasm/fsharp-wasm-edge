# Changelog

All notable changes to this repository are documented here (newest first).

## [Unreleased]

### Added
- **The host moved here from fsharp-wasm-backend**: the core and the stores (`host/runtime`), the adapters for Node, Bun, Deno, Cloudflare Workers
  (with a Durable Object), Vercel and Netlify (`host/adapters`), the GGBP client (`host/client`), the packager (`build/`), the platform matrix
  and the live runner (`tests/platforms`), and the deploy workflow with its documentation.
- **A fixture** (`fixtures/GhostTodo.wasm` with `GhostTodo.provenance.json`): the module the tests run, with the revisions of the source, the
  compiler and the base library it was built from; `tools/fixture.mjs` records a new one and verifies the checked-in one (it also refuses a module
  that imports `wasm:js-string`).
- **CI**: actionlint, the matrix (the same 26 checks on Node, Bun, Deno, workerd, the Vercel Edge Runtime sandbox, the Vercel and Netlify function
  handlers and Netlify's edge runtime; identical answers), and the platforms' own tools on the packages without an account (`wrangler deploy
  --dry-run`, `netlify build --offline`). The tools' versions are in `.github/tool-versions.env`, used by CI and by the deploy workflow.
