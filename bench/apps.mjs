// The three implementations of the same API, each created fresh (an empty store) when a scenario starts.
import { createServer } from "../host/runtime/server.js";
import { memoryStore } from "../host/runtime/stores.js";
import { createJsApp } from "./js-app.mjs";
import { createHonoApp } from "./hono-app.mjs";

/** `module`: a compiled WebAssembly.Module of GhostTodo (compile it once; what that costs is measured apart). */
export const makeApps = ({ module }) => ({
  "F# → WasmGC (host core)": () => createServer({ module, hostName: "bench", store: memoryStore() }),
  "JavaScript (hand-written)": () => createJsApp({ hostName: "bench", store: memoryStore() }),
  "JavaScript (Hono)": () => createHonoApp({ hostName: "bench", store: memoryStore() }),
});

export const req = (method, path, body) =>
  new Request(`http://bench/${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body });
export const json = async (response) => JSON.parse(await response.text());
