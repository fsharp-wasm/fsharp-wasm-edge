// Vercel Edge Functions: the module is imported precompiled (`?module`), so it must be of the Exports string ABI.  State is kept in
// memory per instance (an instance forgets between cold starts and instances do not share it): this is what Edge Functions give.
// For state that outlives an instance, put a store of host/runtime/stores.js over Vercel KV / Edge Config / Blob.
import wasm from "../GhostTodo.wasm?module";
import { createServer } from "../runtime/server.js";
import { memoryStore } from "../runtime/stores.js";
import { assets } from "../runtime/assets.js";

export const config = { runtime: "edge" };

const app = createServer({ module: wasm, hostName: "vercel-edge", store: memoryStore(), assets });
export default (request) => app.fetch(request);
