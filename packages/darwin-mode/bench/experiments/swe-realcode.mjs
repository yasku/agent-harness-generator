// SPDX-License-Identifier: MIT
//
// ADR-120: the SWE loop on THIS package's REAL production code (closes the
// "hand-built toy repos" caveat of ADR-117/118). A real bug is introduced into a
// COPY of the package's own `pareto.ts` (the committed package is never touched);
// the harness's real contextBuilder selects among the 21 REAL src filenames; a
// real LLM is given the selected real source content + a failing test and must
// fix the real TypeScript; a real test is the verdict. Bounded (1 call).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-realcode.mjs [model]

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src'); // packages/darwin-mode/src

// Real candidate corpus: the package's 21 real source filenames.
const realFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

// Work copy (committed package untouched).
const work = mkdtempSync(join(tmpdir(), 'realcode-'));
for (const f of realFiles) cpSync(join(SRC, f), join(work, f));

// Introduce a REAL bug into the copy of pareto.ts: invert the front membership
// (push DOMINATED items instead of non-dominated) — a plausible logic error.
const target = 'pareto.ts';
const orig = readFileSync(join(work, target), 'utf8');
const bugged = orig.replace('if (!dominated) front.push(items[i]);', 'if (dominated) front.push(items[i]);');
if (bugged === orig) { console.log(JSON.stringify({ error: 'bug pattern not found — pareto.ts changed' })); process.exit(1); }
writeFileSync(join(work, target), bugged);

// A real test of paretoFront's contract (strip-types import of the work copy).
const TEST = `import { paretoFront } from './pareto.ts'; import assert from 'node:assert';
// (9,9) dominates (1,1); the front must keep (9,9) and drop (1,1).
const f = paretoFront([{a:9,b:9},{a:1,b:1}], (o)=>[o.a,o.b]);
assert.deepStrictEqual(f, [{a:9,b:9}], 'front must be the non-dominated point');
console.log('PASS');\n`;
writeFileSync(join(work, '_contract_test.mjs'), TEST);
function runTest() { try { execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '_contract_test.mjs'], { cwd: work, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return { pass: true, out: 'PASS' }; } catch (e) { return { pass: false, out: (e.stderr?.toString() || e.message || '').split('\n').slice(0, 4).join(' | ').slice(0, 280) }; } }

const before = runTest();

// The harness's real contextBuilder (from a generated baseline) selects among the
// 21 real package filenames. (buildContext is a generated surface, not a src file.)
const harnessRepo = mkdtempSync(join(tmpdir(), 'realcode-h-'));
mkdirSync(join(harnessRepo, 'src'), { recursive: true });
writeFileSync(join(harnessRepo, 'package.json'), '{"name":"h","version":"1.0.0"}');
writeFileSync(join(harnessRepo, 'src', 'i.js'), 'export const x=1;\n');
const prof = await profileRepo(harnessRepo);
const hw = mkdtempSync(join(tmpdir(), 'realcode-hw-'));
const base = await generateBaselineHarness(prof, hw);
const ctxb = await import(`${base.dir}/context_builder.ts`);
const selected = (ctxb.buildContext('fix the pareto front dominance bug', realFiles) ?? []).map((c) => c.path).slice(0, 6);
const seen = selected.map((f) => `// FILE: ${f}\n${readFileSync(join(work, f), 'utf8')}`).join('\n\n');

const prompt = `A unit test for paretoFront is failing. Among the selected real source files, identify the buggy one and fix it. Return STRICT JSON {"file":"<selected file>","content":"<full corrected file>"}. No fences, no prose.\n--- selected files ---\n${seen}\n--- failing test ---\n${TEST}\n--- test output ---\n${before.out}\n`;
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.1 }) });
const j = await res.json();
let raw = j.choices?.[0]?.message?.content ?? ''; const m = raw.match(/```(?:json)?\n([\s\S]*?)\n```/i); if (m) raw = m[1];
let patch = null; try { patch = JSON.parse(raw); } catch { /**/ }
let after = before, chose = patch?.file ?? null;
if (patch && realFiles.includes(patch.file) && typeof patch.content === 'string') {
  writeFileSync(join(work, patch.file), patch.content); after = runTest();
}
console.log(JSON.stringify({
  model, realCandidateFiles: realFiles.length,
  buggyFileRankedTop: selected[0] === target, llmChoseFile: chose, choseCorrect: chose === target,
  beforePass: before.pass, afterPass: after.pass,
  verdict: !before.pass && after.pass ? 'FIXED (real package code: contextBuilder-selected, LLM-reasoned, real test passes)' : after.pass ? 'already passing' : 'still failing',
  tokens: j.usage?.total_tokens ?? null, cost_usd: j.usage?.cost ?? null,
}, null, 2));
