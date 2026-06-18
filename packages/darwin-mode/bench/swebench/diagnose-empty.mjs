// SPDX-License-Identifier: MIT
// ADR-146 diagnostic: WHY are 200/300 patches empty? Fetch gold patches, extract the file(s)
// each gold patch edits, and check whether the solver SELECTED that file (top-k). Splits the
// failure into: (a) SELECTION MISS (gold file not selected → fix = better localization) vs
// (b) PATCH MISS (gold file selected but no valid edit emitted → fix = patch prompt/format).
// No LLM; just HF dataset + the committed solve report.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const sr = JSON.parse(readFileSync(join(HERE, 'solve-report-300.json'), 'utf8')).instances;
const byId = Object.fromEntries(sr.map((r) => [r.instance_id, r]));
const resolvedIds = new Set(JSON.parse(readFileSync(join(HERE, 'swebench-report-lite300.json'), 'utf8')).resolved_ids);

// gold patch → set of edited file paths
const goldFiles = {};
for (const off of [0, 100, 200]) {
  const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Lite&config=default&split=test&offset=${off}&length=100`);
  for (const { row } of (await r.json()).rows) {
    const files = [...(row.patch || '').matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim());
    goldFiles[row.instance_id] = files;
  }
}

let selHit = 0, selMiss = 0, emptySelHit = 0, emptySelMiss = 0, patchedSelHit = 0, multiFile = 0;
const examples = { emptyButSelected: [], selMissEmpty: [] };
for (const r of sr) {
  const gold = goldFiles[r.instance_id] || [];
  if (gold.length > 1) multiFile++;
  const sel = new Set(r.selected || []);
  const hit = gold.length > 0 && gold.every((f) => sel.has(f)); // ALL gold files selected
  const anyHit = gold.some((f) => sel.has(f));
  const empty = !r.blocksApplied;
  if (anyHit) selHit++; else selMiss++;
  if (empty) { if (anyHit) { emptySelHit++; if (examples.emptyButSelected.length < 5) examples.emptyButSelected.push(r.instance_id); } else { emptySelMiss++; if (examples.selMissEmpty.length < 5) examples.selMissEmpty.push({ id: r.instance_id, gold, files: r.candidateFiles }); } }
  else if (anyHit) patchedSelHit++;
}
const empties = sr.filter((r) => !r.blocksApplied).length;
const out = {
  experiment: 'ADR-146 diagnostic — why patches are empty (selection vs patch failure)',
  n: sr.length, emptyPatch: empties, multiFileGold: multiFile,
  selectionRecall_all: +(100 * selHit / sr.length).toFixed(1),
  emptyPatch_breakdown: {
    total: empties,
    selectionMiss: emptySelMiss, // gold file NOT selected → localization is the bottleneck
    patchMiss: emptySelHit,      // gold file WAS selected but no valid edit emitted → patch format/prompt
    selectionMissPct: +(100 * emptySelMiss / empties).toFixed(1),
  },
  patchedAndSelected: patchedSelHit,
  examples,
  verdict: emptySelMiss > emptySelHit
    ? `SELECTION is the dominant lever: ${emptySelMiss}/${empties} empty patches never had the gold file selected (localization on huge repos). Fix = better file localization.`
    : `PATCH-EMISSION is the dominant lever: ${emptySelHit}/${empties} empties HAD the gold file selected but emitted no valid edit. Fix = patch prompt/format.`,
};
writeFileSync(join(HERE, 'empty-diagnosis.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
