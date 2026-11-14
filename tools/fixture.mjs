// The fixture is a compiled module checked in with the revisions it was built from, so that a change in the host is tested against a module
// that is known, and a change in the module can be tested against the host (the backend repository does that in its CI).
//
//   node tools/fixture.mjs set <module.wasm> --backend <sha> --compiler <sha> --core <sha>   copy it in and write the provenance
//   node tools/fixture.mjs check                                                              the checked-in module is the one the provenance names
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const wasmPath = `${root}fixtures/GhostTodo.wasm`;
const provenancePath = `${root}fixtures/GhostTodo.provenance.json`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What a host needs of a module: valid WebAssembly GC, and no import of the JS String Builtins (the Exports string ABI). */
function inspect(bytes) {
  if (!WebAssembly.validate(bytes)) throw new Error("not a valid WebAssembly module (this Node needs WebAssembly GC: Node 22 or later)");
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
  const builtins = imports.filter((i) => i.module === "wasm:js-string");
  if (builtins.length) throw new Error(`the module imports wasm:js-string (${builtins.map((i) => i.name).join(", ")}): build it with WASMGC_STRING_ABI=exports`);
  return { imports: imports.length, exports: WebAssembly.Module.exports(new WebAssembly.Module(bytes)).length };
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

if (command === "set") {
  const source = rest[0];
  const revisions = { backend: flag("backend"), compiler: flag("compiler"), core: flag("core") };
  if (!source || Object.values(revisions).some((v) => !/^[0-9a-f]{40}$/.test(v ?? ""))) {
    console.error("usage: fixture.mjs set <module.wasm> --backend <40-hex sha> --compiler <40-hex sha> --core <40-hex sha>");
    process.exit(2);
  }
  const bytes = await readFile(source);
  const shape = inspect(bytes);
  await copyFile(source, wasmPath);
  const provenance = {
    module: "GhostTodo.wasm", bytes: bytes.length, sha256: sha256(bytes), stringAbi: "exports", ...shape,
    builtFrom: {
      source: { repository: "fsharp-wasm/fsharp-wasm-backend", commit: revisions.backend, path: "demos/ghost-todo" },
      compiler: { repository: "fsharp-wasm/fsharp-wasm", commit: revisions.compiler },
      core: { repository: "fsharp-wasm/fsharp-wasm-core", commit: revisions.core },
    },
    recorded: new Date().toISOString(),
  };
  await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + "\n");
  console.log(`fixture: ${provenance.bytes} bytes, sha256 ${provenance.sha256.slice(0, 16)}…`);
} else if (command === "check") {
  const bytes = await readFile(wasmPath);
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  inspect(bytes);
  if (sha256(bytes) !== provenance.sha256) { console.error(`fixtures/GhostTodo.wasm (sha256 ${sha256(bytes).slice(0, 16)}…) is not the module its provenance names (${provenance.sha256.slice(0, 16)}…)`); process.exit(1); }
  console.log(`fixture ok: ${bytes.length} bytes, built from backend ${provenance.builtFrom.source.commit.slice(0, 7)} with compiler ${provenance.builtFrom.compiler.commit.slice(0, 7)}`);
} else {
  console.error("usage: fixture.mjs set|check …");
  process.exit(2);
}
