// What an answer that is not `ok` from /healthz says about the deployment.  A person who reads "200 text/html <!DOCTYPE html>…" in a log has to know what a login page
// of a platform looks like; this says it.   node tests/platforms/diagnose.mjs   checks the readings below.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/** The hint for the last answer of a deployment that did not come up, or "" when the answer is not one that has a known cause. */
export function explainNotUp(status, type, text) {
  const html = /text\/html/i.test(type ?? "") || /^\s*<!doctype html/i.test(text ?? "");
  if (/data-dpl-id|vercel\.com\/(sso|login)|Authentication Required/i.test(text ?? ""))
    return "that is the page of Vercel's Deployment Protection, not the module's answer: switch Vercel Authentication off for the project, or enable Protection Bypass for Automation and store its value as the secret VERCEL_AUTOMATION_BYPASS_SECRET (docs/deploy.md, Vercel)";
  if (status === 503 && /shared store/i.test(text ?? "")) {
    if (/unavailable/i.test(text)) return "the module is deployed, but its Redis does not answer (see what it says above: a 401 is a wrong token, a timeout a wrong address): UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN of the platform's project (docs/deploy.md, Shared state)";
    return "the deployment has no Redis to keep its state in: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) in the project's environment on the platform, then deploy again (docs/deploy.md, Shared state)";
  }
  if (status === 401 || status === 403)
    return `the platform answers ${status} before the module is reached: a protection in front of the deployment (Vercel Deployment Protection, a Netlify password, Cloudflare Access); docs/deploy.md`;
  if (status === 200 && html)
    return "an HTML page is not the module's answer: a login or protection page of the platform stands in front of the deployment, or the route does not reach the module (docs/deploy.md)";
  return "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vercelPage = `<!DOCTYPE html><html data-dpl-id="dpl_6s5m84njRuZSFSSguksKQwsgWi5H" class="VEU71W_className ac0vwq_className VEU71W_vari`;
  assert.match(explainNotUp(200, "text/html; charset=utf-8", vercelPage), /Deployment Protection.*VERCEL_AUTOMATION_BYPASS_SECRET/s, "the login page of Vercel, which a fetch reaches after the redirect");
  assert.match(explainNotUp(401, "text/html", "Authentication Required"), /Deployment Protection/, "the 401 of Vercel");
  assert.match(explainNotUp(401, "application/json", "{}"), /protection in front of the deployment/, "any 401");
  assert.match(explainNotUp(200, "text/html", "<!doctype html><title>x</title>"), /HTML page is not the module's answer/, "an HTML page where ok was expected");
  assert.match(explainNotUp(503, "text/plain; charset=utf-8", "the shared store is half configured: both"), /no Redis to keep its state in.*UPSTASH_REDIS_REST_TOKEN/s, "a deployment with no store");
  assert.match(explainNotUp(503, "text/plain", "the shared store is unavailable: it answered 401 (Unauthorized)"), /Redis does not answer.*401 is a wrong token/s, "a store that says no");
  assert.equal(explainNotUp(200, "text/plain", "oops"), "", "an answer with no known cause says nothing");
  assert.equal(explainNotUp(503, "text/plain", "down"), "", "a 5xx says nothing: the platform's own message is in the log");
  console.log("the diagnoses read as they should");
}
