// The same scenario on every platform, and the transcripts compared.
//   node build/package.mjs && node tests/platforms/run.mjs [platform …]
// Needs Node 24 (the packaged `node` and the in-process targets use the string builtins only if the module asks for them; the
// Exports ABI module needs none, but Node 24 is what Vercel and Netlify run), `deno` and `bun` on the PATH or in $TOOLS_BIN (deno).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report } from "./report.mjs";
import { runScenario } from "./scenario.mjs";
import { targets } from "./targets.mjs";

const only = process.argv.slice(2);
const selected = targets.filter((t) => !only.length || only.includes(t.name));
if (!selected.length) { console.error(`no such platform; known: ${targets.map((t) => t.name).join(" ")}`); process.exit(2); }

const dir = await mkdtemp(join(tmpdir(), "ghost-platforms-"));
const results = [];
for (const target of selected) {
  const t0 = Date.now();
  const outcome = { name: target.name, kind: target.kind, host: target.host };
  try {
    let run = await target.start({ dir });
    const result = await runScenario(run.send, { host: target.host });
    Object.assign(outcome, result);
    if (target.persistent) {
      await run.stop();                                             // a restart: the state must come back from the platform's storage
      run = await target.start({ dir });
      const after = await run.send("GET", "api/state");
      outcome.persisted = JSON.stringify(JSON.parse(after.text)) === JSON.stringify(result.finalState);
    }
    await run.stop();
  } catch (e) {
    outcome.error = String(e?.stack ?? e).split("\n").slice(0, 8).join("\n");
  }
  outcome.seconds = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(outcome);
}
await rm(dir, { recursive: true, force: true });

process.exit(report(results) ? 1 : 0);
