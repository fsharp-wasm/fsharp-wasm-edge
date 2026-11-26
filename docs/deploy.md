# Continuous deployment to Cloudflare, Vercel and Netlify

`.github/workflows/deploy.yml` takes the `platforms` artifact of a CI run (what CI built *and* tested — no rebuild), deploys it to the three
platforms, and then runs the platform scenario (`tests/platforms`, 26 checks) against the **live URLs**; the answers of the deployments must
be identical to each other. The result is the run's summary and the `live` artifact (`live.json`).

## Status — read this first

**Nothing has been deployed yet.** There is no account behind this repository, so no URL exists. What is checked, and how (everything but the last row runs in this repository's CI on every push):

| what | how | result |
|---|---|---|
| the Cloudflare package | `wrangler@4.162.0 deploy --dry-run` (bundles the Worker, the `.wasm` as a module, the Durable Object binding; no upload) | bundles |
| the Netlify package | `netlify-cli@27.19.0 build --offline` | the function zip holds `GhostTodo.wasm`; the edge function is routed to `/*` except `/fn` |
| the Vercel package | `vercel@65.16.0 build` needs a valid token even for a local build | **not checked** by the CLI; only the in-process Node handler and the Edge Runtime sandbox of the matrix |
| the workflow | `actionlint` | clean |
| the live runner | `tests/platforms/live.mjs` against local servers over real HTTP (Miniflare listening on a port, the Deno edge harness, the Node handler behind `node:http`); also the failure cases: wrong host name, a warm instance, an unreachable URL | passes / fails as it should |
| the platforms' runtimes | — | **unknown until the first deploy**: that production Cloudflare, Vercel Edge and Netlify accept a WasmGC module is what the first live run decides |

So the first run is the proof, not a formality. If a platform refuses the module, the `live` job says which check failed.

## What the pipeline needs

### GitHub

| setting | where | value |
|---|---|---|
| Environments `cloudflare`, `vercel`, `netlify` | Settings → Environments (created by the first run; add *required reviewers* there if a production deploy needs an approval) | the secrets below can be environment or repository secrets |
| `CD_ENABLED` | Settings → Secrets and variables → Actions → Variables | `true` deploys automatically after every successful CI run on `main`; without it only *Run workflow* deploys |
| `CD_PLATFORMS` (optional) | same | `all` (default) or a list: `cloudflare,netlify` |
| the workflow on `main` | — | `workflow_run` and the *Run workflow* button use the workflow of the default branch |

### Cloudflare — Worker + Durable Object

| | |
|---|---|
| account | any; the free plan is enough (the Durable Object is SQLite-backed, `new_sqlite_classes` in `wrangler.toml`) |
| once | register the account's `workers.dev` subdomain (Dashboard → Workers & Pages); a first `wrangler deploy` of an account without one stops and asks |
| secret `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → *Create Token* → template **Edit Cloudflare Workers**, limited to the account |
| secret `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview, right-hand side |
| variable `CLOUDFLARE_URL` (optional) | a custom domain; otherwise the `…workers.dev` address wrangler prints is used |
| the module | built with `WASMGC_STRING_ABI=exports` (the backend's build does, and `tools/fixture.mjs` refuses a module that imports `wasm:js-string`): a precompiled `.wasm` import cannot use it |

State: one Durable Object per `?room=`; the live runner takes a new room every run, so it can be run again and again.

### Vercel — Edge Function + Node.js function

| | |
|---|---|
| project | create it once (Dashboard → Add New → Project without a Git repository, or `npx vercel link` in `dist/platforms/vercel`); *Framework Preset*: **Other**, no build command, *Node.js Version* **24.x** |
| secret `VERCEL_TOKEN` | Account Settings → Tokens, scope: the team that owns the project |
| secret `VERCEL_ORG_ID` | the team's (or personal account's) ID: Team Settings → General, or `orgId` in `.vercel/project.json` after `vercel link` |
| secret `VERCEL_PROJECT_ID` | Project → Settings → General, or `projectId` in `.vercel/project.json` |
| **Deployment Protection** | a new project answers `401` on its deployment URLs. Either switch *Vercel Authentication* off for the project, or enable *Protection Bypass for Automation* (Project → Settings → Deployment Protection) and store the value as secret `VERCEL_AUTOMATION_BYPASS_SECRET`: the live job sends it as `x-vercel-protection-bypass` (to Vercel only) |

Routes (`vercel.json`): `/api/node` and below → the Node.js function (`api/node.mjs`, base path `/api/node`); everything else → the Edge Function
(`api/edge.js`). The Edge Function imports the module as `./GhostTodo.wasm?module`. This relies on Vercel handing the function the URL the
client asked for (as it does for the usual Express-on-Vercel rewrite); the live run confirms it.

State: memory per instance (see "Instances" below).

### Netlify — Edge Function + function

| | |
|---|---|
| site | create it once (Dashboard → Add new site → Deploy manually, or `npx netlify sites:create`) |
| secret `NETLIFY_AUTH_TOKEN` | User settings → Applications → Personal access tokens |
| secret `NETLIFY_SITE_ID` | Site configuration → Site details → *Project ID* |
| Node version | the function needs **Node ≥ 22** (WebAssembly GC). New sites default to Node 24; an older site takes `NODE_VERSION` (an environment variable of the site) |

`netlify deploy --prod` bundles the function (with `GhostTodo.wasm`, `included_files`) and the edge function on the runner and uploads the result;
Netlify's own build is not involved. Routes: `/fn` and below → the function; everything else → the Edge Function.

State: memory per instance.

## Running it

```bash
# all platforms, the latest successful CI run on main            (Actions → Deploy → Run workflow)
gh workflow run deploy.yml
gh workflow run deploy.yml -f platforms=cloudflare               # one platform
gh workflow run deploy.yml -f run-id=<CI run id>                 # a specific CI run's artifact
```

The live check alone, against deployments that already exist:

```bash
node tests/platforms/live.mjs cloudflare=https://ghost-todo.<subdomain>.workers.dev \
  vercel=https://<project>.vercel.app vercel-node=https://<project>.vercel.app/api/node/ \
  netlify=https://<site>.netlify.app netlify-functions=https://<site>.netlify.app/fn/ --out live.json
# a header a platform needs: LIVE_HEADER_VERCEL="x-vercel-protection-bypass: …"   (never on the command line)
```

## Reading a failure

| symptom | meaning |
|---|---|
| `the secret … is not set` | the step stops before it calls the platform; add the secret (environment or repository) |
| `/healthz did not answer ok` with `401`, or with `200 text/html` and a `<!DOCTYPE html>` | Vercel Deployment Protection (above): `vercel deploy` prints the deployment's own URL, which is protected, and a fetch follows the redirect to Vercel's login page, which answers `200`; the run says so now |
| `/healthz did not answer ok` with a `CompileError` or a 5xx | the platform refused the module: the engine or runtime version is too old for WebAssembly GC, or the string ABI is wrong — the platforms' own message is in the run's log |
| only the state checks fail on Vercel or Netlify (`info`, `healthz`, the page pass) | the requests reached different instances: the state is in memory per instance. A property of the platform, not a bug; a durable state needs a store over Vercel KV / Netlify Blobs (`server/runtime/stores.js`; not written) |
| `the deployment already has state` | the scenario was run before against this instance; deploy again (the workflow always does) |
| `answers differently from …` | the same module gave different bytes on two platforms: a real finding, with the first differing step |

## Instances

Cloudflare gives the module one consistent state (a Durable Object per room). Vercel Functions and Netlify (Edge) Functions keep the state in
memory of whichever instance answers: a sequence of 20 requests from one client usually meets one warm instance, but the platform is free to
use several, and a cold start forgets everything. The live check therefore treats a failure of the *state* checks on these two as information
about the platform, and the table above says so; it does not retry until it is green.
