// SPDX-License-Identifier: MIT
//
// ADR-117 (ADR-098 nucleus with REAL multi-file content): the variant's real
// contextBuilder selects among real source files (varied relevance, ADR-113), a
// real LLM is given the SELECTED FILES' ACTUAL CONTENT + the failing test and must
// identify and fix the bug from the code itself (no hardcoded fix), and the REAL
// test is the verdict. This is the genuine SWE-style loop at micro scale: surface
// selection → real LLM reasoning over real code → real test. Bounded (~1-3 calls).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-nucleus.mjs [model]

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

// A small REAL multi-file repo. intervals.js has a real touching-merge bug; the
// other files are plausible, partly-related distractors (varied relevance).
const FILES = {
  'intervals.js': `// merge overlapping intervals\nexport function merge(intervals){\n  const xs=[...intervals].sort((a,b)=>a[0]-b[0]);\n  const out=[];\n  for(const [s,e] of xs){\n    const last=out[out.length-1];\n    if(last && s < last[1]){ last[1]=Math.max(last[1],e); }\n    else out.push([s,e]);\n  }\n  return out;\n}\n`,
  'sort.js': `export function bySize(a,b){ return (a[1]-a[0])-(b[1]-b[0]); }\n`,
  'format.js': `export function fmt(iv){ return '['+iv[0]+','+iv[1]+']'; }\n`,
  'overlap_utils.js': `// interval overlap helpers\nexport function overlaps(a,b){ return a[0] <= b[1] && b[0] <= a[1]; }\n`,
  'merge_report.js': `// reporting for merge intervals results\nexport function report(n){ return 'merged '+n+' intervals'; }\n`,
};
const TEST = `import { merge } from './intervals.js'; import assert from 'node:assert';
assert.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]],'touching intervals must merge');
assert.deepStrictEqual(merge([[1,3],[2,6],[8,10]]),[[1,6],[8,10]]);
console.log('PASS');\n`;

function makeRepo() {
  const r = mkdtempSync(join(tmpdir(), 'swe-'));
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(r, name), body);
  writeFileSync(join(r, 'test.mjs'), TEST);
  return { dir: r, files: Object.keys(FILES) };
}
function runTest(dir) {
  try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return { pass: true, out: 'PASS' }; }
  catch (e) { return { pass: false, out: (e.stderr?.toString() || e.message || '').split('\n').slice(0, 3).join(' | ').slice(0, 240) }; }
}

const repo = makeRepo();
const prof = await profileRepo(repo.dir);
const wr = mkdtempSync(join(tmpdir(), 'swe-wr-'));
const base = await generateBaselineHarness(prof, wr);
const ctxb = await import(`${base.dir}/context_builder.ts`);

const before = runTest(repo.dir);
// The variant's REAL contextBuilder picks which files the agent sees.
const selected = (ctxb.buildContext('fix the merge intervals bug', repo.files) ?? []).map((c) => c.path);
const top = selected.slice(0, 5);
const seen = top.map((f) => `// FILE: ${f}\n${readFileSync(join(repo.dir, f), 'utf8')}`).join('\n');

const prompt =
  `A test is failing. You are given the files the context builder selected. Identify the buggy file and return a fix.\n` +
  `Return STRICT JSON: {"file":"<one of the selected files>","content":"<full corrected file contents>"}. No prose, no fences.\n\n` +
  `--- selected files ---\n${seen}\n--- failing test (test.mjs) ---\n${TEST}\n--- test output ---\n${before.out}\n`;

const t0 = Date.now();
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1500, temperature: 0.1 }),
});
const j = await res.json();
let raw = j.choices?.[0]?.message?.content ?? '';
const m = raw.match(/```(?:json)?\n([\s\S]*?)\n```/i); if (m) raw = m[1];
let patch = null; try { patch = JSON.parse(raw); } catch { /* leave null */ }
let applied = 'none', after = before;
if (patch && repo.files.includes(patch.file) && typeof patch.content === 'string') {
  writeFileSync(join(repo.dir, patch.file), patch.content);
  applied = patch.file; after = runTest(repo.dir);
}

console.log(JSON.stringify({
  model,
  selectedTopFiles: top,
  buggyFileSelected: top.includes('intervals.js'),
  llmChoseFile: patch?.file ?? null,
  beforePass: before.pass, afterPass: after.pass,
  verdict: !before.pass && after.pass ? 'FIXED (real multi-file: surface-selected, LLM-reasoned, real test passes)' : after.pass ? 'already passing' : 'still failing',
  tokens: j.usage?.total_tokens ?? null, cost_usd: j.usage?.cost ?? null, latency_ms: Date.now() - t0,
}, null, 2));
