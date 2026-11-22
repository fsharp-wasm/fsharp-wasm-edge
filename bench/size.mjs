// What each implementation weighs when it is deployed: the code that is shipped, minified, and gzipped (what a platform transfers).
// The F# module is the WebAssembly (it is not minified further) and the host core that runs it; the JavaScript variants are bundled with esbuild.
//   node bench/size.mjs
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = async (entry) => Buffer.from((await build({ entryPoints: [entry], bundle: true, minify: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"], external: ["node:*"] })).outputFiles[0].text);
const row = (name, parts) => {
  const raw = parts.reduce((n, p) => n + p.length, 0), gz = parts.reduce((n, p) => n + gzipSync(p, { level: 9 }).length, 0);
  console.log(`| ${name} | ${(raw / 1024).toFixed(1)} KB | ${(gz / 1024).toFixed(1)} KB |`);
  return { name, bytes: raw, gzipBytes: gz };
};

const wasm = await readFile(`${root}fixtures/GhostTodo.wasm`);
// the host core and the stores, as one bundle (what a platform package carries beside the module)
const host = await bundle(`${root}host/runtime/server.js`);
const js = await bundle(`${root}bench/js-app.mjs`);
const hono = await bundle(`${root}bench/hono-app.mjs`);
console.log("| deployed code | minified | gzip |\n|---|---:|---:|");
const out = [row("F# → WasmGC: the module", [wasm]), row("F# → WasmGC: the module and the host core", [wasm, host]), row("JavaScript (hand-written)", [js]), row("JavaScript (Hono)", [hono])];
console.log(JSON.stringify(out));
