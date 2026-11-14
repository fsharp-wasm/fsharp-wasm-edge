// What the platforms did, as text: one line per platform (the checks that failed below it), then whether the transcripts agree.
// Returns the number of problems.
export function report(results) {
  let failed = 0;
  console.log("");
  for (const r of results) {
    if (r.error) { failed++; console.log(`✗ ${r.name.padEnd(18)} ${r.kind.padEnd(9)} did not run:\n    ${r.error.split("\n").join("\n    ")}`); continue; }
    const bad = r.checks.filter((c) => !c.ok);
    const persisted = r.persisted === undefined ? "persistence n/a" : r.persisted ? "persisted across a restart" : "NOT persisted";
    if (bad.length || r.persisted === false) failed++;
    console.log(`${bad.length || r.persisted === false ? "✗" : "✓"} ${r.name.padEnd(18)} ${r.kind.padEnd(9)} ${r.checks.length - bad.length}/${r.checks.length} checks, ${persisted}, ${r.seconds}s`);
    for (const c of bad) console.log(`    ✗ ${c.name}  ${c.extra}`);
  }

  // identical behaviour: the transcripts of the platforms that ran are the same
  const ran = results.filter((r) => r.transcript);
  if (ran.length > 1) {
    const reference = ran[0];
    for (const r of ran.slice(1)) {
      const a = reference.transcript, b = r.transcript;
      let diff = a.length !== b.length ? `lengths ${a.length} / ${b.length}` : "";
      for (let i = 0; !diff && i < a.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) diff = `step "${a[i][0]}":\n      ${reference.name}: ${JSON.stringify(a[i]).slice(0, 220)}\n      ${r.name}: ${JSON.stringify(b[i]).slice(0, 220)}`;
      if (diff) { failed++; console.log(`✗ ${r.name} answers differently from ${reference.name}: ${diff}`); }
    }
    if (!failed) console.log(`✓ all ${ran.length} platforms give identical answers (${reference.transcript.length} steps)`);
  }
  console.log(failed ? `\n${failed} problem(s)` : "\nall platforms passed");
  return failed;
}
