// Netlify Functions (Node.js 24; the file comes with `included_files` of netlify.toml), mounted under /fn so that it can live beside the edge function.  The state is in Redis, shared
// with the edge function (docs/deploy.md, Shared state).
import fs from "node:fs/promises";
import { sharedApp } from "../../runtime/shared.js";
import { assets } from "../../runtime/assets.js";

const app = sharedApp({
  module: await fs.readFile(new URL("../../GhostTodo.wasm", import.meta.url)),
  hostName: "netlify-functions",
  basePath: "/fn",
  env: (name) => process.env[name],
  assets,
});
export default (request, context) => {
  const response = app.fetch(request);
  context?.waitUntil?.(response.then(() => app.settled(), () => {}));
  return response;
};
export const config = { path: ["/fn", "/fn/*"] };
