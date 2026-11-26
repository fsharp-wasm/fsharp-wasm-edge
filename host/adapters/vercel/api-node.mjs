// Vercel Functions on the Node.js runtime (24): web-standard handlers, mounted under /api/node (vercel.json rewrites the sub-paths to this file and Vercel hands the function the URL
// the client asked for).  The state is in Redis, shared with the edge function (docs/deploy.md, Shared state).
import fs from "node:fs/promises";
import { sharedApp } from "../runtime/shared.js";
import { assets } from "../runtime/assets.js";

const app = sharedApp({
  module: await fs.readFile(new URL("../GhostTodo.wasm", import.meta.url)),
  hostName: "vercel-node",
  basePath: "/api/node",
  env: (name) => process.env[name],
  assets,
});
const handle = (request, context) => {
  const response = app.fetch(request);
  context?.waitUntil?.(response.then(() => app.settled(), () => {}));
  return response;
};
export { handle as GET, handle as POST, handle as DELETE, handle as OPTIONS, handle as HEAD };
