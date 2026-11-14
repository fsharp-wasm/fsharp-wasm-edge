// Gives the edge function of the Netlify package what Netlify's edge runtime (Deno) gives it: a Request and a context.
const mod = await import(new URL(`file://${Deno.cwd()}/netlify/edge-functions/ghost.mjs`));
Deno.serve({ port: Number(Deno.env.get("PORT")) }, (request) => mod.default(request, {}));
