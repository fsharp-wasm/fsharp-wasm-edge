// The platforms.  Each target starts what the platform runs (the packaged directory of dist/platforms/<name>) and gives
// `send(method, path, { body, headers })`.  A target says how real it is: "process" is the platform's own runtime serving
// HTTP; "emulated" is a faithful stand-in for the platform's runtime, not the platform itself.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EdgeVM } from "@edge-runtime/vm";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";
import { toRequest, toResult, viaFetch } from "./http.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = (name) => join(root, "dist/platforms", name);
const tools = process.env.TOOLS_BIN ?? "";            // a directory with node / deno / bun when they are not on the PATH
const exe = (name) => (tools && name !== "bun" ? join(tools, name) : name);

// Vercel and Netlify keep the state in Redis (host/runtime/shared.js): the targets that do read where it is from their environment, and the runner gives each of them a room of its own.
const storeEnv = (state) => (state.upstash ? { UPSTASH_REDIS_REST_URL: state.upstash.url, UPSTASH_REDIS_REST_TOKEN: state.upstash.token } : {});

const freePort = () => new Promise((resolve) => { const s = netServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server process of the platform's own runtime. */
function processTarget({ name, host, command, args, env = () => ({}), cwd, persistent = false, shared = false }) {
  return {
    name, host, kind: "process", persistent, shared,
    async start(state) {
      const port = await freePort();
      const child = spawn(command, args, { cwd, env: { ...process.env, PORT: String(port), ...env(state) }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const base = `http://127.0.0.1:${port}/`;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`${name} exited early:\n${output}`);
        try { const r = await fetch(`${base}healthz`); if (r.ok) break; } catch { /* not yet */ }
        await sleep(100);
      }
      return { send: viaFetch(base), stop: async () => { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); } };
    },
  };
}

/** A handler that is called in this process (the platform's entry contract, without its HTTP front).  `load(state, again)` imports the adapter afresh when `again` (a restart: nothing of the instance is left). */
let imports = 0;
const handlerTarget = ({ name, host, load, base = "http://localhost/" }) => ({
  name, host, kind: "emulated", persistent: true, shared: true,
  async start(state) {
    Object.assign(process.env, storeEnv(state));              // the adapter reads its environment when it is imported
    const handler = await load(`?instance=${++imports}`);
    return { send: async (method, path, init) => toResult(await handler(toRequest(base, method, path, init))), stop: async () => {} };
  },
});

export const targets = [
  processTarget({
    name: "node", host: "node", command: exe("node"), args: [join(pkg("node"), "index.mjs")], persistent: true,
    env: (s) => ({ STATE_FILE: join(s.dir, "node-state.json") }),
  }),
  processTarget({
    name: "bun", host: "bun", command: exe("bun"), args: [join(pkg("bun"), "index.mjs")], persistent: true,
    env: (s) => ({ STATE_FILE: join(s.dir, "bun-state.json") }),
  }),
  processTarget({
    name: "deno", host: "deno", command: exe("deno"), persistent: true, cwd: pkg("deno"),
    args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--unstable-kv", "main.mjs"],
    env: (s) => ({ DENO_KV_PATH: join(s.dir, "deno-kv.sqlite") }),
  }),
  // Netlify Edge Functions run on Deno: the edge function of the package, served by a harness that gives it a Request
  processTarget({
    name: "netlify-edge", host: "netlify-edge", command: exe("deno"), cwd: pkg("netlify"), persistent: true, shared: true,
    args: ["run", "--allow-net", "--allow-read", "--allow-env", join(root, "tests/platforms/harness/netlify-edge.mjs")],
    env: storeEnv,
  }),
  {
    // Cloudflare Workers: the Worker and the Durable Object of the package on workerd (through Miniflare), with persisted Durable Object storage
    name: "cloudflare", host: "cloudflare-workers", kind: "emulated", persistent: true,
    async start(state) {
      const dir = pkg("cloudflare");
      const mod = async (path) => ({ type: "ESModule", path, contents: await readFile(join(dir, path), "utf8") });
      const mf = new Miniflare({
        compatibilityDate: "2025-01-01",
        modules: [
          await mod("worker.js"), await mod("runtime/server.js"), await mod("runtime/stores.js"), await mod("runtime/assets.js"),
          { type: "CompiledWasm", path: "GhostTodo.wasm", contents: await readFile(join(dir, "GhostTodo.wasm")) },
        ],
        durableObjects: { GHOST_TODO: { className: "GhostTodo", useSQLite: true } },
        durableObjectsPersist: join(state.dir, "cloudflare-do"),
        cache: false,
      });
      const base = "http://localhost/";
      // Miniflare has its own Request class: give it the URL and the init, not a Request of this realm
      return {
        send: async (method, path, { body, headers } = {}) =>
          toResult(await mf.dispatchFetch(new URL(path, base).href, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body })),
        stop: () => mf.dispose(),
      };
    },
  },
  {
    // Vercel Edge Functions: the edge adapter bundled the way Vercel's loader makes it (`?module` is a ready WebAssembly.Module), run in
    // the Edge Runtime sandbox, which allows no compilation of WebAssembly from bytes
    name: "vercel-edge", host: "vercel-edge", kind: "emulated", persistent: true, shared: true,
    async start(state) {
      const dir = pkg("vercel");
      const bundle = await esbuild.build({
        entryPoints: [join(dir, "api/edge.js")], bundle: true, write: false, format: "iife", globalName: "edge", platform: "neutral",
        plugins: [{ name: "wasm-module", setup: (b) => {
          b.onResolve({ filter: /\.wasm\?module$/ }, () => ({ path: "wasm-module", namespace: "wasm" }));
          b.onLoad({ filter: /.*/, namespace: "wasm" }, () => ({ contents: "export default globalThis.__WASM_MODULE;", loader: "js" }));
        } }],
      });
      const module = new WebAssembly.Module(await readFile(join(dir, "GhostTodo.wasm")));
      // the Edge Runtime has `process.env`: the environment of the project
      const vm = new EdgeVM({ extend: (context) => { context.__WASM_MODULE = module; context.process = { env: storeEnv(state) }; return context; } });
      vm.evaluate(bundle.outputFiles[0].text);
      vm.evaluate(`globalThis.__call = async (method, url, headers, body) => {
        const res = await edge.default(new Request(url, { method, headers, body: body === null ? undefined : body }));
        return JSON.stringify({ status: res.status, headers: [...res.headers], bytes: [...new Uint8Array(await res.arrayBuffer())] });
      };`);
      const base = "http://localhost/";
      return {
        send: async (method, path, { body, headers } = {}) => {
          const r = JSON.parse(await vm.evaluate(`__call(${JSON.stringify(method)}, ${JSON.stringify(new URL(path, base).href)}, ${JSON.stringify(headers ?? {})}, ${JSON.stringify(method === "GET" ? null : body ?? "")})`));
          const bytes = Uint8Array.from(r.bytes);
          const h = Object.fromEntries(r.headers);
          return { status: r.status, type: h["content-type"] ?? "", headers: h, text: new TextDecoder().decode(bytes), bytes };
        },
        stop: async () => {},
      };
    },
  },
  handlerTarget({
    name: "vercel-node", host: "vercel-node", base: "http://localhost/api/node/",
    load: async (again) => { const m = await import(pathToFileURL(join(pkg("vercel"), "api/node.mjs")).href + again); return (req) => ({ GET: m.GET, POST: m.POST, DELETE: m.DELETE, OPTIONS: m.OPTIONS, HEAD: m.HEAD })[req.method](req); },
  }),
  handlerTarget({
    name: "netlify-functions", host: "netlify-functions", base: "http://localhost/fn/",
    load: async (again) => (await import(pathToFileURL(join(pkg("netlify"), "netlify/functions/ghost.mjs")).href + again)).default,
  }),
];
