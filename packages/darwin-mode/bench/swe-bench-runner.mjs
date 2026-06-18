// SPDX-License-Identifier: MIT
//
// ADR-125 — the consolidated, corpus-ready SWE-bench runner. ONE function an external
// corpus iterates: `for (const task of dataset) await runSweBenchTask(task, opts)`.
// It unifies the pieces proven separately:
//   - ADR-123: auto-derive FAIL_TO_PASS/PASS_TO_PASS + the real resolved criterion.
//   - ADR-124's DECISION: the reliable patch primitive is whole-file → `git diff` → apply
//     (raw LLM diffs corrupt). So the model emits a whole corrected file; the runner writes
//     it, captures the real unified-diff artifact via `git diff`, and scores the criterion.
// The harness's own contextBuilder does file selection (real, gated). No fabrication: every
// number returned is a measured test outcome.
//
// A `task` is: {
//   instance_id, problem_statement, test_suites: string[],
//   materialize(workDir): void   // populate workDir with the repo at the FAILING base state
// }
// Returns: { instance_id, resolved, f2p, p2p, chose, patchBytes, tokens, cost_usd }.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../dist/generator.js';
import { profileRepo } from '../dist/repo_profiler.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@b' };
const g = (work, c) => execSync(c, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });

function runTests(work, suites) {
  const out = join(work, '_vitest.json');
  try { execSync(`npx vitest run ${suites.join(' ')} --reporter=json --outputFile=${out}`, { cwd: work, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* fails → JSON still written */ }
  if (!existsSync(out)) return {};
  const j = JSON.parse(readFileSync(out, 'utf8')); const map = {};
  for (const tr of j.testResults ?? []) { const f = (tr.name || '').split('/').pop()?.replace('.test.ts', ''); for (const a of tr.assertionResults ?? []) map[`${f} › ${a.title}`] = a.status; }
  return map;
}

const evaluate = (F, P, after) => ({
  resolved: F.length > 0 && F.every((t) => after[t] === 'passed') && P.every((t) => after[t] === 'passed'),
  f2p: `${F.filter((t) => after[t] === 'passed').length}/${F.length}`,
  p2p: `${P.filter((t) => after[t] === 'passed').length}/${P.length}`,
});

export async function runSweBenchTask(task, { model = 'google/gemini-2.5-flash', key, pkgPath } = {}) {
  key = (key || process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

  // 1. Materialize the repo at the failing base state; git-init so we can diff/apply.
  const work = mkdtempSync(join(tmpdir(), `swe-${task.instance_id}-`.replace(/[^a-z0-9-]/gi, '')));
  task.materialize(work);
  g(work, 'git init -q'); g(work, 'git add -A'); g(work, 'git commit -qm base');

  // 2. Auto-derive FAIL_TO_PASS (failing now) / PASS_TO_PASS (passing now). (ADR-123)
  const baseRun = runTests(work, task.test_suites);
  const F2P = Object.keys(baseRun).filter((t) => baseRun[t] === 'failed');
  const P2P = Object.keys(baseRun).filter((t) => baseRun[t] === 'passed');

  // 3. The harness's real contextBuilder selects among the repo's source files. (gated)
  const realFiles = readdirSync(join(work, 'src')).filter((f) => f.endsWith('.ts'));
  const hr = mkdtempSync(join(tmpdir(), 'swe-h-')); writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}');
  const b = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'swe-hw-')));
  const { buildContext } = await import(`${b.dir}/context_builder.ts`);
  const selected = (buildContext(task.problem_statement, realFiles) ?? []).map((c) => c.path).slice(0, 6);
  const seen = selected.map((f) => `// FILE: ${f}\n${readFileSync(join(work, 'src', f), 'utf8')}`).join('\n\n');

  // 4. Model emits a WHOLE corrected file (ADR-124: reliable, unlike raw diffs).
  const prompt = `${task.problem_statement}\nIdentify the buggy file among the selected sources and fix it. Return STRICT JSON {"file":"<selected file>","content":"<full corrected file>"}. No fences/prose.\n--- selected files ---\n${seen}\n--- failing tests ---\n${F2P.join('\n')}\n`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.1 }) });
  const j = await res.json();
  let raw = j.choices?.[0]?.message?.content ?? ''; const m = raw.match(/```(?:json)?\n([\s\S]*?)\n```/i); if (m) raw = m[1];
  let patch = null; try { patch = JSON.parse(raw); } catch { /**/ }

  // 5. Apply by writing the whole file; capture the real unified-diff artifact via `git diff`.
  let patchBytes = 0, chose = patch?.file ?? null;
  if (patch && realFiles.includes(patch.file) && typeof patch.content === 'string') {
    writeFileSync(join(work, 'src', patch.file), patch.content);
    patchBytes = g(work, 'git diff').toString().length; // the appliable artifact (provenance)
  }

  // 6. Score the real resolved criterion.
  const verdict = evaluate(F2P, P2P, runTests(work, task.test_suites));
  return { instance_id: task.instance_id, ...verdict, FAIL_TO_PASS: F2P.length, PASS_TO_PASS: P2P.length, chose, patchBytes, tokens: j.usage?.total_tokens ?? null, cost_usd: j.usage?.cost ?? null };
}
