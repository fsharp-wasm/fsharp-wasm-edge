// Before anything is timed: the three implementations must answer the same requests the same way (status and body), or the numbers compare different programs.
import { req, json } from "./apps.mjs";

// the same value, whatever the order of the keys (no node: imports: this file runs in workerd too)
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const isDeepStrictEqual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const steps = [
  ["GET", "api/info"], ["GET", "api/state"],
  ["POST", "api/todos", '{"text":"Write the docs"}'], ["POST", "api/todos", '{"text":"Grüße ✓ 🚀 日本語"}'], ["POST", "api/todos", '{"text":"   "}'], ["POST", "api/todos", "{oops"],
  ["POST", "api/todos", `{"text":"${"x".repeat(201)}"}`],
  ["POST", "api/todos/1/toggle"], ["POST", "api/todos/99/toggle"], ["DELETE", "api/todos/2"], ["DELETE", "api/todos/2"],
  ["POST", "api/todos", '{"text":"after"}'],
  ["GET", "api/state"], ["GET", "api/patches?since=0"], ["GET", "api/patches?since=1"], ["GET", "api/patches?since=4"], ["GET", "api/patches"], ["GET", "api/nope"],
];

/** The answers of one implementation to `steps`: [status, body] for each. */
const transcript = async (make) => {
  const app = make(), out = [];
  for (const [method, path, body] of steps) {
    const r = await app.fetch(req(method, path, body));
    out.push([method + " " + path, r.status, await json(r).catch(() => null)]);
  }
  return out;
};

export async function checkEquivalence(apps) {
  const names = Object.keys(apps), reference = await transcript(apps[names[0]]), problems = [];
  for (const name of names.slice(1)) {
    const other = await transcript(apps[name]);
    reference.forEach((step, i) => { if (!isDeepStrictEqual(step, other[i])) problems.push(`${name} differs at ${step[0]}: ${JSON.stringify(step.slice(1))} vs ${JSON.stringify(other[i].slice(1))}`); });
  }
  return { steps: steps.length, implementations: names.length, problems };
}
