// What is timed.  Each scenario seeds a fresh app, then runs `op` for a time budget and records every call.
import { req, json } from "./apps.mjs";

const seed = async (app, n) => { for (let i = 0; i < n; i++) await app.fetch(req("POST", "api/todos", JSON.stringify({ text: `todo ${i}` }))); };
const add = (app, text = "x") => app.fetch(req("POST", "api/todos", JSON.stringify({ text })));

export const scenarios = [
  { name: "poll, nothing new", what: "GET /api/patches?since=<latest> — what both clients ask once a second", todos: 100,
    prepare: async (app, n) => ({ since: n }), op: (app, ctx) => app.fetch(req("GET", `api/patches?since=${ctx.since}`)) },
  { name: "state, 100 todos", what: "GET /api/state — a client that starts or resynchronises", todos: 100, prepare: async () => ({}), op: (app) => app.fetch(req("GET", "api/state")) },
  { name: "state, 5 000 todos", what: "the same with a big list (about 250 KB of JSON)", todos: 5000, prepare: async () => ({}), op: (app) => app.fetch(req("GET", "api/state")) },
  { name: "toggle, 100 todos", what: "POST /api/todos/:id/toggle — a patch, and the state persisted whole", todos: 100, prepare: async () => ({ i: 0 }), op: (app, ctx) => app.fetch(req("POST", `api/todos/${1 + (ctx.i++ % 100)}/toggle`)) },
  { name: "toggle, 5 000 todos", what: "the same with a big list: the persisted snapshot is 5 000 todos long", todos: 5000, prepare: async () => ({ i: 0 }), op: (app, ctx) => app.fetch(req("POST", `api/todos/${1 + (ctx.i++ % 5000)}/toggle`)) },
  { name: "add + remove, 100 todos", what: "two requests per call; the list stays at 100", todos: 100, prepare: async () => ({}),
    op: async (app) => { const { todo } = await json(await add(app)); return app.fetch(req("DELETE", `api/todos/${todo.id}`)); }, requests: 2 },
];

export const prepareApp = async (scenario, app) => { await seed(app, scenario.todos); return scenario.prepare(app, scenario.todos); };
