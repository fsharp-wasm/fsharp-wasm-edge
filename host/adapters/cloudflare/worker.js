// Cloudflare Workers: the module runs inside a Durable Object, one per room (?room=…, default "main").  A Durable Object keeps its
// instance in memory between requests and persists the state in its own storage, so the module sees one consistent state without
// a store round trip; the Worker in front serves the page and routes by room.
// The module is imported precompiled (a WebAssembly.Module): it must be of the Exports string ABI (WASMGC_STRING_ABI=exports).
import wasm from "./GhostTodo.wasm";
import { createServer, serveAsset } from "./runtime/server.js";
import { durableObjectStore } from "./runtime/stores.js";
import { assets } from "./runtime/assets.js";

export class GhostTodo {
  constructor(state) {
    this.state = state;
    this.app = createServer({ module: wasm, hostName: "cloudflare-workers", store: durableObjectStore(state.storage) });
  }
  async fetch(request) {
    const response = await this.app.fetch(request);
    // the module's `idle` call (folding its log into a checkpoint) runs after the response; the object is kept until it is done
    this.state.waitUntil(this.app.settled());
    return response;
  }
}

export default {
  fetch(request, env) {
    const page = serveAsset(assets, request);
    if (page) return page;
    const room = new URL(request.url).searchParams.get("room") ?? "main";
    return env.GHOST_TODO.get(env.GHOST_TODO.idFromName(room)).fetch(request);
  },
};
