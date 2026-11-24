// The fixtures are compiled modules checked in with the revisions they were built from, so that a change in the host is tested against a module
// that is known, and a change in the module can be tested against the host (the backend repository does that in its CI).
//
//   node tools/fixture.mjs set <module.wasm> --backend <sha> --compiler <sha> --core <sha>   the module the host runs: copy it in and write the provenance
//   node tools/fixture.mjs set-canvas <dist/canvas> --backend <sha> --compiler <sha> --core <sha> --graphics <sha> --runtime <sha>
//                                                                                              the canvas client the host serves below /canvas/: its page, its module, its runtime
//   node tools/fixture.mjs check                                                              both are the ones their provenance names
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const wasmPath = `${root}fixtures/GhostTodo.wasm`;
const provenancePath = `${root}fixtures/GhostTodo.provenance.json`;
const canvasDir = `${root}fixtures/canvas`;
const canvasProvenancePath = `${root}fixtures/GhostTodoCanvas.provenance.json`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A fixture is recorded without its name section: it is for debuggers and profilers, a third of a module (measured 2026-11-24: 59 814 bytes with it, a third less without), and no host needs it. Needs wasm-tools on the PATH. */
async function withoutNames(bytes) {
  const dir = await mkdtemp(`${tmpdir()}/fixture-`);
  try {
    await writeFile(`${dir}/in.wasm`, bytes);
    execFileSync("wasm-tools", ["strip", "-d", "^name$", `${dir}/in.wasm`, "-o", `${dir}/out.wasm`]);
    return await readFile(`${dir}/out.wasm`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** What a host needs of a module: valid WebAssembly GC, and no import of the JS String Builtins (the Exports string ABI). */
function inspect(bytes) {
  if (!WebAssembly.validate(bytes)) throw new Error("not a valid WebAssembly module (this Node needs WebAssembly GC: Node 22 or later)");
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
  const builtins = imports.filter((i) => i.module === "wasm:js-string");
  if (builtins.length) throw new Error(`the module imports wasm:js-string (${builtins.map((i) => i.name).join(", ")}): build it with WASMGC_STRING_ABI=exports`);
  return { imports: imports.length, exports: WebAssembly.Module.exports(new WebAssembly.Module(bytes)).length };
}

/** What a browser needs of the canvas client: valid WebAssembly GC that imports the browser's glue (runtime/*.js) and nothing of a host's (runtime/server.js). */
function inspectCanvas(bytes) {
  if (!WebAssembly.validate(bytes)) throw new Error("not a valid WebAssembly module");
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const server = imports.filter((i) => i.module === "runtime/server.js");
  if (server.length) throw new Error(`the canvas client imports the host's runtime/server.js (${server.map((i) => i.name).join(", ")}): it carries the host binding of FSharp.Wasm.Server`);
  return { imports: imports.length, exports: WebAssembly.Module.exports(module).length };
}

const filesOf = async (dir) => {
  const files = [];
  for (const rel of await readdir(dir, { recursive: true })) if ((await stat(`${dir}/${rel}`)).isFile()) files.push(rel);
  return files.sort();
};

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

if (command === "set") {
  const source = rest[0];
  const revisions = { backend: flag("backend"), compiler: flag("compiler"), core: flag("core") };
  if (!source || Object.values(revisions).some((v) => !/^[0-9a-f]{40}$/.test(v ?? ""))) {
    console.error("usage: fixture.mjs set <module.wasm> --backend <40-hex sha> --compiler <40-hex sha> --core <40-hex sha>");
    process.exit(2);
  }
  const bytes = await withoutNames(await readFile(source));
  const shape = inspect(bytes);
  await writeFile(wasmPath, bytes);
  const provenance = {
    module: "GhostTodo.wasm", bytes: bytes.length, sha256: sha256(bytes), stringAbi: "exports", names: "stripped", ...shape,
    builtFrom: {
      source: { repository: "fsharp-wasm/fsharp-wasm-backend", commit: revisions.backend, path: "demos/ghost-todo" },
      compiler: { repository: "fsharp-wasm/fsharp-wasm", commit: revisions.compiler },
      core: { repository: "fsharp-wasm/fsharp-wasm-core", commit: revisions.core },
    },
    recorded: new Date().toISOString(),
  };
  await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + "\n");
  console.log(`fixture: ${provenance.bytes} bytes, sha256 ${provenance.sha256.slice(0, 16)}…`);
} else if (command === "set-canvas") {
  const source = rest[0];
  const revisions = { backend: flag("backend"), compiler: flag("compiler"), core: flag("core"), graphics: flag("graphics"), runtime: flag("runtime") };
  if (!source || Object.values(revisions).some((v) => !/^[0-9a-f]{40}$/.test(v ?? ""))) {
    console.error("usage: fixture.mjs set-canvas <dist/canvas> --backend <sha> --compiler <sha> --core <sha> --graphics <sha> --runtime <sha>   (each a 40-hex sha)");
    process.exit(2);
  }
  const bytes = await withoutNames(await readFile(`${source}/GhostTodoCanvas.wasm`));
  const shape = inspectCanvas(bytes);
  await rm(canvasDir, { recursive: true, force: true });
  await mkdir(canvasDir, { recursive: true });
  await cp(source, canvasDir, { recursive: true });
  await writeFile(`${canvasDir}/GhostTodoCanvas.wasm`, bytes);
  const provenance = {
    module: "GhostTodoCanvas.wasm", bytes: bytes.length, sha256: sha256(bytes), stringAbi: "js-string builtins", names: "stripped", ...shape, files: await filesOf(canvasDir),
    builtFrom: {
      source: { repository: "fsharp-wasm/fsharp-wasm-backend", commit: revisions.backend, path: "demos/ghost-todo-canvas" },
      compiler: { repository: "fsharp-wasm/fsharp-wasm", commit: revisions.compiler },
      core: { repository: "fsharp-wasm/fsharp-wasm-core", commit: revisions.core },
      graphics: { repository: "fsharp-wasm/fsharp-wasm-graphics", commit: revisions.graphics },
      runtime: { repository: "fsharp-wasm/fsharp-wasm-runtime", commit: revisions.runtime },
    },
    recorded: new Date().toISOString(),
  };
  await writeFile(canvasProvenancePath, JSON.stringify(provenance, null, 2) + "\n");
  console.log(`canvas fixture: ${provenance.files.length} files, module ${provenance.bytes} bytes, sha256 ${provenance.sha256.slice(0, 16)}…`);
} else if (command === "check") {
  const bytes = await readFile(wasmPath);
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  inspect(bytes);
  if (sha256(bytes) !== provenance.sha256) { console.error(`fixtures/GhostTodo.wasm (sha256 ${sha256(bytes).slice(0, 16)}…) is not the module its provenance names (${provenance.sha256.slice(0, 16)}…)`); process.exit(1); }
  console.log(`fixture ok: ${bytes.length} bytes, built from backend ${provenance.builtFrom.source.commit.slice(0, 7)} with compiler ${provenance.builtFrom.compiler.commit.slice(0, 7)}`);
  const canvasProvenance = JSON.parse(await readFile(canvasProvenancePath, "utf8").catch(() => "null"));
  if (canvasProvenance) {
    const canvasBytes = await readFile(`${canvasDir}/GhostTodoCanvas.wasm`);
    inspectCanvas(canvasBytes);
    if (sha256(canvasBytes) !== canvasProvenance.sha256) { console.error(`fixtures/canvas/GhostTodoCanvas.wasm is not the module its provenance names`); process.exit(1); }
    const files = await filesOf(canvasDir);
    if (JSON.stringify(files) !== JSON.stringify(canvasProvenance.files)) { console.error(`fixtures/canvas holds ${files.join(", ")}; its provenance names ${canvasProvenance.files.join(", ")}`); process.exit(1); }
    console.log(`canvas fixture ok: ${files.length} files, module ${canvasBytes.length} bytes, built from backend ${canvasProvenance.builtFrom.source.commit.slice(0, 7)}`);
  }
} else {
  console.error("usage: fixture.mjs set|check …");
  process.exit(2);
}
