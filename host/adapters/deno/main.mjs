// Deno and Deno Deploy.   PORT (default 8787; ignored on Deploy)   DENO_KV_PATH  a file for Deno KV; without it, the default KV
// (on Deploy: the project's global KV; locally: in memory with ":memory:")
import { createServer } from "./runtime/server.js";
import { denoKvStore } from "./runtime/stores.js";
import { assets } from "./runtime/assets.js";

const kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH") ?? undefined);
const app = createServer({
  module: await Deno.readFile(new URL("./GhostTodo.wasm", import.meta.url)),
  hostName: "deno",
  store: denoKvStore(kv, "ghost-todo"),
  // instances of a deployment share the KV: read the state again for every request
  reload: Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined,
  assets,
});
Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8787) }, (request) => app.fetch(request));
