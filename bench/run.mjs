// The benchmark on this runtime (Node or Bun): every scenario on every implementation, in-process, so what is timed is the module and the framework — no network.
//   node bench/run.mjs [--budget 800] [--json out.json]        bun bench/run.mjs
import { readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { makeApps } from "./apps.mjs";
import { checkEquivalence } from "./equivalence.mjs";
import { scenarios, prepareApp } from "./scenarios.mjs";

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const budgetMs = Number(flag("budget", 800));
const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.versions.node}`;

const bytes = await readFile(flag("wasm", `${root}fixtures/GhostTodo.wasm`));
// what a cold start costs the module: compile, and instantiate with the host's imports (the first request is part of the scenarios)
const coldStart = (() => { const t = performance.now(); const m = new WebAssembly.Module(bytes); return { compileMs: performance.now() - t, module: m }; })();
const apps = makeApps({ module: coldStart.module });

const eq = await checkEquivalence(apps);
console.log(`${runtime} · ${cpus()[0].model} · ${cpus().length} cores`);
console.log(`equivalence: ${eq.steps} requests on ${eq.implementations} implementations: ${eq.problems.length ? "DIFFER" : "identical answers"}`);
if (eq.problems.length) { console.error(eq.problems.join("\n")); process.exit(1); }

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const results = [];
for (const scenario of scenarios) {
  for (const [name, make] of Object.entries(apps)) {
    const app = make();
    const ctx = await prepareApp(scenario, app);
    const warm = performance.now() + Math.min(300, budgetMs / 2);
    while (performance.now() < warm) await scenario.op(app, ctx);
    const samples = [];
    const end = performance.now() + budgetMs;
    for (let t = performance.now(); t < end; ) { await scenario.op(app, ctx); const t2 = performance.now(); samples.push((t2 - t) * 1000 / (scenario.requests ?? 1)); t = t2; }
    samples.sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    results.push({ scenario: scenario.name, implementation: name, requests: samples.length * (scenario.requests ?? 1), meanUs: mean, p50Us: pct(samples, 0.5), p95Us: pct(samples, 0.95), p99Us: pct(samples, 0.99), perSecond: 1e6 / mean });
  }
}

const fmt = (us) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(1)} µs`);
for (const scenario of scenarios) {
  console.log(`\n${scenario.name} — ${scenario.what}`);
  console.log("| implementation | median | p95 | p99 | requests/s |\n|---|---:|---:|---:|---:|");
  for (const r of results.filter((x) => x.scenario === scenario.name)) console.log(`| ${r.implementation} | ${fmt(r.p50Us)} | ${fmt(r.p95Us)} | ${fmt(r.p99Us)} | ${Math.round(r.perSecond).toLocaleString("en")} |`);
}
console.log(`\ncold start of the module: compile ${coldStart.compileMs.toFixed(2)} ms (${bytes.length} bytes)`);

const out = flag("json");
if (out) await writeFile(out, JSON.stringify({ date: new Date().toISOString(), runtime, cpu: cpus()[0].model, cores: cpus().length, budgetMs, equivalence: eq, coldStart: { compileMs: coldStart.compileMs, bytes: bytes.length }, results }, null, 2) + "\n");
