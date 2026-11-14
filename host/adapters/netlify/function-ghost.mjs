// Netlify Functions (Node.js 24; the file comes with `included_files` of netlify.toml), mounted under /fn so that it can live beside the
// edge function.  State is in memory per instance.
import fs from "node:fs/promises";
import { createServer } from "../../runtime/server.js";
import { memoryStore } from "../../runtime/stores.js";
import { assets } from "../../runtime/assets.js";

const app = createServer({
  module: await fs.readFile(new URL("../../GhostTodo.wasm", import.meta.url)),
  hostName: "netlify-functions",
  basePath: "/fn",
  store: memoryStore(),
  assets,
});
export default (request) => app.fetch(request);
export const config = { path: ["/fn", "/fn/*"] };
