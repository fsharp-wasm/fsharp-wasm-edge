# Deploying the packages

`node build/package.mjs` makes one directory per platform in `dist/platforms/`. Each is complete (the adapter where the platform expects
its entry, `runtime/`, `GhostTodo.wasm`, the configuration). **None of this has been deployed from here**: the matrix runs the same
code on the platform's runtime or an emulation of it (see the README), and these steps are the platforms' documented ways, not something this
repository has done. What a continuous deployment needs (accounts, tokens, settings) and what has been checked without one is in
[deploy.md](deploy.md).

## Cloudflare Workers + Durable Object

```bash
cd dist/platforms/cloudflare
npx wrangler dev        # workerd locally
npx wrangler deploy
```

`wrangler.toml` binds the Durable Object class `GhostTodo` (SQLite-backed, so it is available on the free plan). The Worker serves the page
and routes `?room=<name>` (default `main`) to the Durable Object of that room; the object keeps the module's instance in memory and persists
the state in its own storage. The `.wasm` import gives a precompiled module: it must be built with `WASMGC_STRING_ABI=exports` (the backend repository's `build/build.sh` does).

## Vercel

```bash
cd dist/platforms/vercel
npx vercel deploy
```

`vercel.json` rewrites every path to `api/edge.js` (an Edge Function: `?module` makes the `.wasm` a ready `WebAssembly.Module`);
`api/node.mjs` is the same on the Node.js runtime (24), mounted at `/api/node` (a rewrite hands it the sub-paths). State is memory per instance.

## Netlify

```bash
cd dist/platforms/netlify
npx netlify deploy
```

`netlify/edge-functions/ghost.mjs` answers every path but `/fn` (Deno; the module's bytes travel in `wasm-bytes.js`, an edge function cannot read
files); `netlify/functions/ghost.mjs` is the Node.js function, mounted under `/fn` (`basePath`) with `included_files = ["GhostTodo.wasm"]`.

## Deno and Deno Deploy

```bash
cd dist/platforms/deno
deno run --allow-net --allow-read --allow-env --unstable-kv main.mjs     # deno task start
deployctl deploy --entrypoint=main.mjs
```

The state is in Deno KV; on Deploy the instances share it, so the core reads the state again before every request (`reload`).

## Bun and Node

```bash
bun dist/platforms/bun/index.mjs             # PORT, STATE_FILE
node dist/platforms/node/index.mjs           # PORT, STATE_FILE (Node 22+ for WebAssembly GC; 24 is what the matrix runs)
```

## Writing another module

`FSharp.Wasm.Server` (in [fsharp-wasm-backend](https://github.com/fsharp-wasm/fsharp-wasm-backend)) gives the handler its request and takes its response (`Host.run`), and the store (`Host.store`). Export `handle`
(and `reset` if the state may have to be read again); build with `WASMGC_STRING_ABI=exports`; give `build/package.mjs` the module (`GHOST_WASM=<path>`; the default is `fixtures/GhostTodo.wasm`), or
call `createServer({ module, hostName, store, assets })` from `host/runtime/server.js` yourself.
