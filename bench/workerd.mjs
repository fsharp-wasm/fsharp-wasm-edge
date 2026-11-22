// The benchmark on workerd, the engine of Cloudflare Workers, through Miniflare (local: no network, no Cloudflare machine).
//   node bench/workerd.mjs [--json out.json]
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const bundle = await build({ entryPoints: [`${root}bench/worker.mjs`], bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], external: ["./GhostTodo.wasm"] });
const mf = new Miniflare({
  compatibilityDate: "2025-01-01", cache: false,
  modules: [
    { type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0].text },
    { type: "CompiledWasm", path: "GhostTodo.wasm", contents: await readFile(`${root}fixtures/GhostTodo.wasm`) },
  ],
});
const get = async (path) => (await mf.dispatchFetch(`http://bench/${path}`)).json();

const eq = await get("equivalence");
console.log(`workerd (miniflare) · ${cpus()[0].model} · ${cpus().length} cores`);
console.log(`equivalence: ${eq.steps} requests on ${eq.implementations} implementations: ${eq.problems.length ? "DIFFER" : "identical answers"}`);
if (eq.problems.length) { console.error(eq.problems.join("\n")); process.exit(1); }

const { scenarios, apps } = await get("prepare?scenario=0&app=0");
const names = ["poll, nothing new", "state, 100 todos", "state, 5 000 todos", "toggle, 100 todos", "toggle, 5 000 todos", "add + remove, 100 todos"];
const results = [];
for (let s = 0; s < scenarios; s++) {
  console.log(`\n${names[s]}\n| implementation | mean | requests/s |\n|---|---:|---:|`);
  for (let a = 0; a < apps.length; a++) {
    await get(`prepare?scenario=${s}&app=${a}`);
    await get("run?n=20");                                              // warm
    let t = performance.now(); await get("run?n=20"); const probe = (performance.now() - t) / 20;
    const n = Math.max(20, Math.round(800 / probe));                    // about 0.8 s of calls
    t = performance.now(); const { n: requests } = await get(`run?n=${n}`); const ms = performance.now() - t;
    const meanUs = (ms * 1000) / requests;
    results.push({ scenario: names[s], implementation: apps[a], requests, meanUs, perSecond: 1e6 / meanUs });
    console.log(`| ${apps[a]} | ${meanUs >= 1000 ? (meanUs / 1000).toFixed(2) + " ms" : meanUs.toFixed(1) + " µs"} | ${Math.round(1e6 / meanUs).toLocaleString("en")} |`);
  }
}
const out = flag("json");
if (out) await writeFile(out, JSON.stringify({ date: new Date().toISOString(), runtime: "workerd (miniflare)", cpu: cpus()[0].model, cores: cpus().length, equivalence: eq, note: "mean of a batch timed from outside; workerd freezes the clock inside a Worker", results }, null, 2) + "\n");
await mf.dispose();
