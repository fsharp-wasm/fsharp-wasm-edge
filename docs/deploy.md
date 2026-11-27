# Continuous deployment to Cloudflare, Vercel and Netlify

`.github/workflows/deploy.yml` takes the `platforms` artifact of a CI run (what CI built *and* tested — no rebuild), deploys it to the three
platforms, and then runs the platform scenario (`tests/platforms`, 29 checks) against the **live URLs**; the answers of the deployments must
be identical to each other. The result is the run's summary and the `live` artifact (`live.json`).

## Status — read this first

**The first deploy ran on 2026-11-27** (the `Deploy` run 46061722882 on `main`). What answers, as measured by the live runner and by a request to each address on the same day:

| platform | address | what answers |
|---|---|---|
| Cloudflare Workers + Durable Object | `https://ghost-todo.sascha-dewald.workers.dev` | **all 29 checks pass** against the live address; the platform accepts the WebAssembly GC module (`WASMGC_STRING_ABI=exports`) |
| Vercel | `https://fsharp-wasm-edge.vercel.app` | the page answers `200`; `/healthz` answers `503` "no shared store is configured" |
| Netlify | `https://fsharp-wasm-edge.netlify.app` | the same as Vercel |

On Vercel and Netlify the `503` is the host's own answer before the module runs, because no Redis is set (see the two sections below). So what is **not shown yet** is that
production Vercel (Edge and Node) and Netlify (Edge and Functions) run the module: the live runner has to pass there too, and that needs the Redis variables first.
Until then those four rows of the matrix stay "not exercised on the platform".

What is checked besides, and how (everything but the live rows runs in this repository's CI on every push):

| what | how | result |
|---|---|---|
| the Cloudflare package | `wrangler@4.162.0 deploy --dry-run` (bundles the Worker, the `.wasm` as a module, the Durable Object binding; no upload) | bundles; deployed and live (above) |
| the Netlify package | `netlify-cli@27.19.0 build --offline` | the function zip holds `GhostTodo.wasm`; the edge function is routed to `/*` except `/fn`; deployed (above) |
| the Vercel package | `vercel@65.16.0 build` needs a valid token even for a local build | **not checked** by the CLI in CI; deployed by the workflow (above), the in-process Node handler and the Edge Runtime sandbox of the matrix cover the rest |
| the workflow | `actionlint` | clean |
| the live runner | `tests/platforms/live.mjs` against local servers over real HTTP (Miniflare listening on a port, the Deno edge harness, the Node handler behind `node:http`); also the failure cases: wrong host name, a warm instance, an un-configured store | passes; against the real addresses: Cloudflare 29 of 29, Vercel and Netlify wait for the store |

**What it needs next** (the maintainer sets these in the project settings of the two platforms, not in the chat): an Upstash Redis, and its two variables in both projects, either
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` or the `KV_REST_API_URL` and `KV_REST_API_TOKEN` of Vercel's Upstash integration. Then *Run workflow* on `Deploy` runs the live check again.

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

| the state | a Redis (Upstash) that the project's environment points to: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or the `KV_REST_API_URL` and `KV_REST_API_TOKEN` that Vercel's Upstash integration sets. Without them every request but the page answers `503` and says what is missing ("Shared state" below) |

State: Redis, shared by the edge function and the Node.js function.

### Netlify — Edge Function + function

| | |
|---|---|
| site | create it once (Dashboard → Add new site → Deploy manually, or `npx netlify sites:create`) |
| secret `NETLIFY_AUTH_TOKEN` | User settings → Applications → Personal access tokens |
| secret `NETLIFY_SITE_ID` | Site configuration → Site details → *Project ID* |
| Node version | the function needs **Node ≥ 22** (WebAssembly GC). New sites default to Node 24; an older site takes `NODE_VERSION` (an environment variable of the site) |
| the state | a Redis (Upstash): the site's environment variables `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (Site configuration → Environment variables; scopes: *Functions* and *Edge Functions*). Without them every request but the page answers `503` ("Shared state" below) |

`netlify deploy --prod` bundles the function (with `GhostTodo.wasm`, `included_files`) and the edge function on the runner and uploads the result;
Netlify's own build is not involved. Routes: `/fn` and below → the function; everything else → the Edge Function.

State: Redis, shared by the edge function and the function.

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
| `/healthz` answers `503` and says `the shared store …` | Vercel or Netlify without a Redis, or with one that says no: the message says which (`half configured`, `unavailable: … 401` is a wrong token, a timeout a wrong address). Set the two variables of the project on the platform, deploy again |
| `the room already has state` | the scenario found todos in a room it just made up: a clash of two runs at once, or a leftover; run it again |
| `answers differently from …` | the same module gave different bytes on two platforms: a real finding, with the first differing step |

## Shared state (Vercel, Netlify)

On Cloudflare one Durable Object is the state of a room: it lives in one place, so requests meet one after the other. Vercel and Netlify give that to nobody: a request may reach any instance, an
instance is gone between two requests, and none of them holds the state. The state therefore lives in a database, and the rule of every request is the same:

1. read the **version** of the state (and its entries, when the version is not the one the instance already holds);
2. run the module over it;
3. **commit** what it changed *only if the version is still the one that was read*, and raise the version by one — in one step the database cannot interleave.

A commit that lost has written nothing: the request is run again over what the winner wrote (up to twelve times, after a random wait that grows), so the instances that race for one state make progress
one after another and every change is one version. Beyond twelve attempts the answer is `503` with `retry-after`. A database that does not answer is a `503` that says so; **there is no fallback to memory**:
a state that differs from instance to instance works until the second instance answers.

| | |
|---|---|
| code | `host/runtime/stores.js` (`versionedStore`: the store; `upstashShared`: Redis through Upstash's REST API, which an edge function can use as it has no TCP socket; `memoryShared`: the reference of what a database must do), `host/runtime/shared.js` (the app of Vercel and Netlify: rooms, the environment, the 503s), the retry in `host/runtime/server.js` |
| rooms | `?room=<1–64 of A-Z a-z 0-9 - _>`, default `main`: a state of its own (the live runner takes a new one every run). A room other than `main` is forgotten a day after its last write |
| a database must | give a version and the entries in one read; commit puts and deletes in one step that fails when the version moved; nothing else. `tests/host/shared-store.mjs` holds every implementation to the same checks, against the reference and against the real thing |
| Redis | the two steps are scripts that Redis runs without another command in between (the one place that is not F# or JavaScript: they are the database's own language, about fifteen lines in `stores.js`); the test runs them on a real `redis-server` behind a stand-in for Upstash's REST protocol (`tests/platforms/upstash.mjs`) |
| size | the whole state of a room is read when its version changed: the module keeps it small (its log is folded into a checkpoint); Upstash's request limit is 1 MB on the free plan |
| not Netlify Blobs | its documentation says *last write wins* and gives no conditional write with one winner, which this needs |
