// Vercel Edge Functions: the module is imported precompiled (`?module`), so it must be of the Exports string ABI.  Any request may reach any instance and an instance forgets between
// cold starts, so the state is in Redis (Upstash; docs/deploy.md, Shared state) and every request commits against the version it read.  Without a store the answer is 503.
import wasm from "../GhostTodo.wasm?module";
import { sharedApp } from "../runtime/shared.js";
import { assets } from "../runtime/assets.js";

export const config = { runtime: "edge" };

const app = sharedApp({ module: wasm, hostName: "vercel-edge", env: (name) => process.env[name], assets });
// the module's `idle` call (folding its log into a checkpoint) runs after the response; the instance is kept until it is done
export default (request, context) => {
  const response = app.fetch(request);
  context?.waitUntil?.(response.then(() => app.settled(), () => {}));
  return response;
};
