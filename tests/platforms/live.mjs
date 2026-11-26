// The scenario of the matrix against deployments: the same checks, and the transcripts compared with each other.
//   node tests/platforms/live.mjs cloudflare=https://… vercel=https://… netlify=https://… netlify-functions=https://…/fn/ [--out live.json]
//
// platform           what it is                                           the host it must name
//   cloudflare         the Worker + Durable Object                          cloudflare-workers
//   vercel             the Edge Function (every path)                       vercel-edge
//   vercel-node        the Node.js function, mounted under /api/node        vercel-node
//   netlify            the Edge Function (every path but /fn)               netlify-edge
//   netlify-functions  the Node.js function, mounted under /fn              netlify-functions
//
// The scenario expects an empty list.  Every platform keeps its state by room (`?room=`: a Durable Object on Cloudflare, a namespace of the shared Redis on Vercel and Netlify), and
// every run takes a new room, so a deployment does not have to be new.  A room other than the default expires from Redis a day after its last write.
// Headers a platform needs (Vercel's protection bypass) come from $LIVE_HEADER_<PLATFORM>, "name: value", never from the command line.
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { viaFetch } from "./http.mjs";
import { report } from "./report.mjs";
import { runScenario } from "./scenario.mjs";
import { explainNotUp } from "./diagnose.mjs";

const byRoom = (room) => (url) => url.searchParams.set("room", room);
const platforms = {
  cloudflare: { host: "cloudflare-workers", scope: byRoom },
  vercel: { host: "vercel-edge", scope: byRoom },
  "vercel-node": { host: "vercel-node", scope: byRoom },
  netlify: { host: "netlify-edge", scope: byRoom },
  "netlify-functions": { host: "netlify-functions", scope: byRoom },
};

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const requested = args.map((a) => { const i = a.indexOf("="); return i < 0 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)]; }).filter(([, url]) => url);
if (!requested.length) { console.error(`usage: live.mjs <platform>=<url> …   known: ${Object.keys(platforms).join(" ")}`); process.exit(2); }
const unknown = requested.filter(([name]) => !platforms[name]);
if (unknown.length) { console.error(`no such platform: ${unknown.map(([n]) => n).join(" ")}; known: ${Object.keys(platforms).join(" ")}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headersOf = (name) => {
  const raw = process.env[`LIVE_HEADER_${name.toUpperCase().replace(/-/g, "_")}`];
  const at = raw?.indexOf(":") ?? -1;
  return at > 0 && raw.slice(at + 1).trim() ? { [raw.slice(0, at).trim()]: raw.slice(at + 1).trim() } : {};
};

/** A deployment takes a moment to answer (propagation, a cold start): wait for /healthz, not for the scenario to pass. */
async function waitUntilUp(send, seconds = Number(process.env.LIVE_WAIT_SECONDS ?? 90)) {
  const deadline = Date.now() + seconds * 1000;
  let last = "no answer";
  let answer = null;
  while (Date.now() < deadline) {
    try {
      const r = await send("GET", "healthz");
      if (r.status === 200 && r.text === "ok") return;
      answer = r;
      last = `${r.status} ${r.type} ${r.text.slice(0, 120)}`;
    } catch (e) { answer = null; last = String(e.cause?.message ?? e.message); }
    await sleep(2000);
  }
  const hint = answer ? explainNotUp(answer.status, answer.type, answer.text) : "";
  throw new Error(`/healthz did not answer ok within ${seconds}s (last: ${last})${hint ? `\n    ${hint}` : ""}`);
}

/** The scenario expects an empty list: say so, instead of failing somewhere in the middle of it. */
async function requireFresh(send) {
  const r = await send("GET", "api/state");
  let version; try { version = JSON.parse(r.text).version; } catch { /* not JSON: the scenario reports it */ }
  if (version > 0) throw new Error(`the room already has state (version ${version}): the scenario needs an empty one`);
}

const room = `live-${randomBytes(4).toString("hex")}`;
const results = [];
for (const [name, url] of requested) {
  const { host, scope } = platforms[name];
  const t0 = Date.now();
  const outcome = { name, kind: "live", host, url };
  try {
    const send = viaFetch(url.endsWith("/") ? url : `${url}/`, { headers: headersOf(name), scope: scope?.(room), timeoutMs: 30000 });
    await waitUntilUp(send);
    await requireFresh(send);
    Object.assign(outcome, await runScenario(send, { host }));
  } catch (e) {
    outcome.error = String(e?.stack ?? e).split("\n").slice(0, 8).join("\n");
  }
  outcome.seconds = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(outcome);
}

const failed = report(results);
if (out) await writeFile(out, JSON.stringify({ schema: "live-1", date: new Date().toISOString(), room, results: results.map(({ transcript, ...r }) => ({ ...r, steps: transcript?.length ?? 0 })) }, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.name} | ${r.url} | ${r.error ? "did not run" : `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`} | ${r.seconds}s |`);
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Live: the scenario against the deployments\n\n| platform | URL | checks | time |\n|---|---|---|---|\n${rows.join("\n")}\n\n${failed ? `${failed} problem(s)` : "identical answers on every platform"}\n`, { flag: "a" });
}
process.exit(failed ? 1 : 0);
