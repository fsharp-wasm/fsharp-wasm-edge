// The benchmark inside workerd (the engine of Cloudflare Workers): the same apps and scenarios as run.mjs.  workerd freezes the clock while a Worker only computes
// (a protection against timing attacks), so nothing is timed in here: `/prepare` makes an app and seeds it, `/run?n=` runs n calls, and bench/workerd.mjs times the batch from outside.
import wasm from "./GhostTodo.wasm";
import { makeApps } from "./apps.mjs";
import { scenarios, prepareApp } from "./scenarios.mjs";
import { checkEquivalence } from "./equivalence.mjs";

const apps = makeApps({ module: wasm });
let current = null;

export default {
  async fetch(request) {
    const url = new URL(request.url), q = (k) => Number(url.searchParams.get(k));
    if (url.pathname === "/equivalence") return Response.json(await checkEquivalence(apps));
    if (url.pathname === "/prepare") {
      const scenario = scenarios[q("scenario")], app = Object.values(apps)[q("app")]();
      current = { scenario, app, ctx: await prepareApp(scenario, app) };
      return Response.json({ scenarios: scenarios.length, apps: Object.keys(apps) });
    }
    if (url.pathname === "/run") {
      const { scenario, app, ctx } = current;
      for (let i = 0; i < q("n"); i++) await scenario.op(app, ctx);
      return Response.json({ n: q("n") * (scenario.requests ?? 1) });
    }
    return new Response("/prepare, /run, /equivalence", { status: 404 });
  },
};
