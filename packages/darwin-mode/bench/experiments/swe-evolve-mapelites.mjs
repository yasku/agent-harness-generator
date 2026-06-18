// SPDX-License-Identifier: MIT
//
// ADR-140 — the rigorous capstone: do the failed ADR-136/137 evolution RIGHT. ADR-136 showed a
// naive n=1 single-gene hill-climb traps at a local optimum (gemini/wholefile) and never reaches
// the global optimum (deepseek/searchreplace); ADR-137 showed naive crossover loses the deepseek
// building block (it hitchhikes on a bad wholefile gene and is selected out); ADR-138 quantified
// the n=1 noise (sd≈0.45). This combines all three fixes:
//   (1) DIVERSITY-PRESERVING selection — MAP-Elites with one niche per MODEL, so the deepseek gene
//       SURVIVES even in a low-fitness (wholefile) body (ADR-088/091);
//   (2) CROSSOVER across niche elites — recombines genes into deepseek/searchreplace (ADR-089/093/105);
//   (3) AVERAGED fitness (N runs) — beats the noise floor so selection is reliable (ADR-138).
// Genome = {model, patchMode}; maxAttempts fixed at 2. Does it reach the optimum greedy missed?
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-evolve-mapelites.mjs

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const N = 3; // runs averaged per genome (ADR-138: n≈4-5 ideal; 3 to bound cost)

const SPECS = [
  { id: 'kernel-js', pkg: 'kernel-js', suites: ['trajectory'],
    problem: 'The trajectory store rotateIfLarger rotates a small file and skips rotation when over the size limit — the size threshold is inverted.',
    bug: { file: 'src/trajectory.ts', from: 'if (s.size <= maxBytes) return false;', to: 'if (s.size > maxBytes) return false;' } },
  { id: 'create-agent-harness', pkg: 'create-agent-harness', suites: ['constraints'],
    problem: 'The constraints summarise function reports allHardPass true even when a hard constraint fails.',
    bug: { file: 'src/constraints.ts', from: 'allHardPass: hard.every((r) => r.passed),', to: 'allHardPass: hard.some((r) => r.passed),' } },
  { id: 'vertical-base', pkg: 'vertical-base', suites: ['base'],
    problem: 'validateVerticalManifest accepts an empty string id instead of rejecting it.',
    bug: { file: 'src/index.ts', from: "if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id must be a string');", to: "if (typeof m.id !== 'string') throw new Error('manifest.id must be a string');" } },
];

function taskFor(spec, g) {
  const root = join(PKGS, spec.pkg);
  return {
    instance_id: spec.id, problem_statement: spec.problem, test_suites: spec.suites,
    patchMode: g.patchMode, maxAttempts: 2, selectK: 6,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, f))) cpSync(join(root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, spec.bug.file); writeFileSync(p, readFileSync(p, 'utf8').replace(spec.bug.from, spec.bug.to));
    },
  };
}
const short = (m) => m.split('/')[1];
const key = (g) => `${short(g.model)}/${g.patchMode}`;
const cache = new Map();
async function fitness(g) { // AVERAGED over N runs (ADR-138 noise fix)
  if (cache.has(key(g))) return cache.get(key(g));
  const res = [];
  for (let i = 0; i < N; i++) { let resolved = 0; for (const spec of SPECS) { let r; try { r = await runSweBenchTask(taskFor(spec, g), { model: g.model }); } catch { r = { resolved: false }; } if (r.resolved) resolved++; } res.push(resolved); }
  const mean = res.reduce((a, b) => a + b, 0) / N;
  const f = { genome: key(g), model: short(g.model), meanResolved: Math.round(mean * 100) / 100, runs: res.map((r) => `${r}/3`) };
  cache.set(key(g), f); return f;
}
const better = (a, b) => b.meanResolved - a.meanResolved;
const cross = (a, b) => [{ model: a.model, patchMode: b.patchMode }, { model: b.model, patchMode: a.patchMode }];

// MAP-Elites archive: one niche per MODEL (diversity preservation — keeps the deepseek gene alive).
const niche = new Map(); // model -> {g, f}
function consider(g, f) { const m = f.model; if (!niche.has(m) || better(f, niche.get(m).f) < 0) niche.set(m, { g, f }); }

// Gen 0: a DIVERSE seed — deepseek gene lives in a wholefile body (low fitness, but its MODEL niche
// preserves it); searchreplace gene lives in gpt-5-mini; gemini is the ADR-136 local-optimum region.
const seeds = [
  { model: 'google/gemini-2.5-flash', patchMode: 'wholefile' },
  { model: 'deepseek/deepseek-chat', patchMode: 'wholefile' },
  { model: 'openai/gpt-5-mini', patchMode: 'searchreplace' },
];
for (const g of seeds) consider(g, await fitness(g));

// Crossover across all pairs of niche elites → offspring (recombination assembles deepseek/searchreplace).
const elites = [...niche.values()].map((e) => e.g);
const offspring = [];
for (let i = 0; i < elites.length; i++) for (let k = i + 1; k < elites.length; k++) offspring.push(...cross(elites[i], elites[k]));
const seen = new Set(seeds.map(key));
for (const child of offspring) { if (seen.has(key(child))) continue; seen.add(key(child)); consider(child, await fitness(child)); }

const all = [...cache.values()].sort((a, b) => better(a, b));
const best = all[0];
const reached = best.genome === 'deepseek-chat/searchreplace';
console.log(JSON.stringify({
  experiment: 'ADR-140 — MAP-Elites (per-model niches) + crossover + averaged fitness',
  corpus: SPECS.map((s) => s.id), runsAveraged: N, genome: 'model × patchMode (maxAttempts=2)',
  nicheElites: [...niche.values()].map((e) => `${e.f.genome}:${e.f.meanResolved}/3`),
  fitnessLandscape: all.map((f) => ({ genome: f.genome, meanResolved: f.meanResolved, runs: f.runs })),
  globalBest: { genome: best.genome, meanResolved: best.meanResolved, runs: best.runs },
  reachedGlobalOptimum: reached,
  verdict: reached
    ? `DIVERSITY+CROSSOVER+AVERAGING WINS: reached the global optimum '${best.genome}' (${best.meanResolved}/3 avg) — recombined from genes preserved across model niches, with averaged fitness defeating the noise. The optimum ADR-136's naive n=1 greedy could NOT reach. ADR-105 reproduced RIGOROUSLY on real SWE code.`
    : `global best '${best.genome}' (${best.meanResolved}/3) — report as measured`,
}, null, 2));
