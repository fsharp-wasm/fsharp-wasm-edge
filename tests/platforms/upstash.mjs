// A real Redis behind Upstash's REST protocol, for the tests: `redis-server` runs the scripts (the atomicity the store relies on is Redis's own, not ours), and a small HTTP server in
// front takes what Upstash takes (`POST /` with a JSON array, `Authorization: Bearer`) and answers what it answers (`{"result": …}`, or `{"error": …}` with a 4xx).
//   const redis = await startUpstash();   redis.url   redis.token   await redis.stop()
// `redis-server` is on the PATH (apt: redis-server) or named by $REDIS_SERVER; `startUpstash()` is `null` when there is none.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { connect, createServer as netServer } from "node:net";

const freePort = () => new Promise((resolve) => { const s = netServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One RESP value from the start of `buf`: [value, bytes used], or null when the reply is not complete yet. */
function parse(buf, at = 0) {
  const end = buf.indexOf("\r\n", at);
  if (end < 0) return null;
  const kind = String.fromCharCode(buf[at]);
  const line = buf.toString("utf8", at + 1, end);
  const next = end + 2;
  switch (kind) {
    case "+": return [line, next];
    case "-": return [{ error: line }, next];
    case ":": return [Number(line), next];
    case "$": {
      const n = Number(line);
      if (n < 0) return [null, next];
      if (buf.length < next + n + 2) return null;
      return [buf.toString("utf8", next, next + n), next + n + 2];
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return [null, next];
      const items = [];
      let pos = next;
      for (let i = 0; i < n; i++) {
        const item = parse(buf, pos);
        if (!item) return null;
        items.push(item[0]);
        pos = item[1];
      }
      return [items, pos];
    }
    default: throw new Error(`RESP: unexpected ${JSON.stringify(kind)}`);
  }
}

const encode = (command) => Buffer.concat([
  Buffer.from(`*${command.length}\r\n`),
  ...command.map((arg) => { const b = Buffer.from(String(arg)); return Buffer.concat([Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")]); }),
]);

const send = (port, command) => new Promise((resolve, reject) => {
  const socket = connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    const reply = parse(buf);
    if (reply) { socket.end(); resolve(reply[0]); }
  });
  socket.on("error", reject);
  socket.on("connect", () => socket.write(encode(command)));
});

export const redisServer = () => {
  const exe = process.env.REDIS_SERVER ?? "redis-server";
  return spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0 ? exe : null;
};

export async function startUpstash() {
  const exe = redisServer();
  if (!exe) return null;
  const redisPort = await freePort();
  const redis = spawn(exe, ["--port", String(redisPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { if ((await send(redisPort, ["PING"])) === "PONG") break; } catch { /* not yet */ }
    if (i > 100) { redis.kill(); throw new Error("redis-server did not come up"); }
    await sleep(50);
  }

  const token = randomBytes(12).toString("hex");
  const http = httpServer((req, res) => {
    const answer = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST") return answer(405, { error: "method not allowed" });
    if (req.headers.authorization !== `Bearer ${token}`) return answer(401, { error: "Unauthorized" });
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let command;
      try { command = JSON.parse(body); } catch { return answer(400, { error: "ERR failed to parse command" }); }
      if (!Array.isArray(command) || !command.length) return answer(400, { error: "ERR a command is a non-empty array" });
      try {
        const reply = await send(redisPort, command);
        reply?.error ? answer(400, { error: reply.error }) : answer(200, { result: reply });
      } catch (e) { answer(500, { error: String(e.message) }); }
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  return {
    url, token,
    /** Redis itself: for a test that looks at what the store left. */
    command: (...c) => send(redisPort, c),
    async stop() {
      http.closeAllConnections?.();
      await new Promise((resolve) => http.close(resolve));
      redis.kill();
      await new Promise((resolve) => redis.once("exit", resolve));
    },
  };
}
