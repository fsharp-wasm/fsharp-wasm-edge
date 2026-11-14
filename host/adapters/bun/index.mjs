// Bun.   PORT (default 8787)   STATE_FILE  a JSON file the state is kept in; without it, memory
import fs from "node:fs/promises";
import { createServer } from "./runtime/server.js";
import { fileStore, memoryStore } from "./runtime/stores.js";
import { assets } from "./runtime/assets.js";

const app = createServer({
  module: await Bun.file(new URL("./GhostTodo.wasm", import.meta.url)).arrayBuffer(),
  hostName: "bun",
  store: process.env.STATE_FILE ? fileStore(process.env.STATE_FILE, fs) : memoryStore(),
  assets,
});
const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: (request) => app.fetch(request) });
console.log(`ghost-todo on bun ${Bun.version}: http://localhost:${server.port}/`);
