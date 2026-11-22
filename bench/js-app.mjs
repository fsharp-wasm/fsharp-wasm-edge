// The Ghost Todo API as plain JavaScript on web-standard Request and Response: a hand-written router around logic.mjs.
import { createLogic, respond, parseSince, badSince } from "./logic.mjs";

export function createJsApp({ store, hostName }) {
  const logic = createLogic({ store });
  return {
    async fetch(request) {
      const url = new URL(request.url), segs = url.pathname.split("/").filter(Boolean), m = request.method;
      const txn = Number(request.headers.get("x-transaction")) || undefined;
      if (m === "GET" && segs[0] === "api" && segs[1] === "info") return respond(logic.info(hostName));
      if (m === "GET" && segs[0] === "api" && segs[1] === "state") return respond(logic.state());
      if (m === "GET" && segs[0] === "api" && segs[1] === "patches") { const s = parseSince(url.searchParams.get("since")); return respond(s === null ? badSince : logic.patches(s)); }
      if (m === "POST" && segs[0] === "api" && segs[1] === "todos" && segs.length === 2) { let b; try { b = JSON.parse(await request.text()); } catch { b = null; } return respond(logic.add(b?.text, txn)); }
      if (m === "POST" && segs[0] === "api" && segs[1] === "todos" && segs[3] === "toggle") return respond(logic.toggle(Number(segs[2]), txn));
      if (m === "DELETE" && segs[0] === "api" && segs[1] === "todos" && segs.length === 3) return respond(logic.remove(Number(segs[2]), txn));
      return respond({ status: 404, body: { error: "not found" } });
    },
  };
}
