// The same API on Hono, the framework most edge applications are written with, around the same logic.mjs.
import { Hono } from "hono";
import { createLogic, respond, parseSince, badSince } from "./logic.mjs";

export function createHonoApp({ store, hostName }) {
  const logic = createLogic({ store });
  const app = new Hono();
  const txn = (c) => Number(c.req.header("x-transaction")) || undefined;
  app.get("/api/info", () => respond(logic.info(hostName)));
  app.get("/api/state", () => respond(logic.state()));
  app.get("/api/patches", (c) => { const s = parseSince(c.req.query("since")); return respond(s === null ? badSince : logic.patches(s)); });
  app.post("/api/todos", async (c) => { let b; try { b = JSON.parse(await c.req.text()); } catch { b = null; } return respond(logic.add(b?.text, txn(c))); });
  app.post("/api/todos/:id/toggle", (c) => respond(logic.toggle(Number(c.req.param("id")), txn(c))));
  app.delete("/api/todos/:id", (c) => respond(logic.remove(Number(c.req.param("id")), txn(c))));
  app.notFound(() => respond({ status: 404, body: { error: "not found" } }));
  return { fetch: (request) => app.fetch(request) };
}
