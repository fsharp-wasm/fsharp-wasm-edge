// Node (24+, for WebAssembly GC with the string builtins; any version with WebAssembly GC for a module of the Exports string ABI).
//   PORT (default 8787)   STATE_FILE  a JSON file the state is kept in; without it, memory
import http from "node:http";
import fs from "node:fs/promises";
import { createServer } from "./runtime/server.js";
import { fileStore, memoryStore } from "./runtime/stores.js";
import { assets } from "./runtime/assets.js";

const app = createServer({
  module: await fs.readFile(new URL("./GhostTodo.wasm", import.meta.url)),
  hostName: "node",
  store: process.env.STATE_FILE ? fileStore(process.env.STATE_FILE, fs) : memoryStore(),
  assets,
});

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""]),
    body: hasBody && chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(Number(process.env.PORT ?? 8787), () => console.log(`ghost-todo on node ${process.version}: http://localhost:${server.address().port}/`));
