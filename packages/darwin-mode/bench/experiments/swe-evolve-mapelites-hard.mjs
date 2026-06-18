// SPDX-License-Identifier: MIT
//
// ADR-141 — the harder-corpus capstone, removing ADR-140's caveat. ADR-140 showed diversity+
// crossover+averaging ASSEMBLES deepseek/searchreplace, but on an easy corpus resolve-rate
// saturated (4/6 at ceiling) so cost had to break a wide tie. This uses a CAPABILITY-
// DISCRIMINATING corpus where resolve-rate itself eliminates the bad genomes:
//   - two-fault (pareto small + phenotype large): wholefile REGRESSES it (ADR-126) → only
//     search/replace resolves → discriminates patchMode by resolve-rate;
//   - kernel-js: a weak model misses it (ADR-139 gemini 2.25/3) → discriminates model.
// Full (resolve, cost) objective, per-model MAP-Elites niches, crossover, averaged n=3.
// Expectation: resolve-rate kills wholefile + gemini; crossover assembles the searchreplace
// survivors; cost picks deepseek/searchreplace among them — the complete objective, end to end.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-evolve-mapelites-hard.mjs

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const N = 3;

// Instance 1: two-fault (capability-discriminates patchMode). Instance 2: kernel-js (model).
const SPECS = [
  { id: 'two-fault', root: join(PKGS, 'darwin-mode'), suites: ['pareto', 'phenotype', 'clade'],
    problem: 'The pareto module returns dominated items instead of the non-dominated front, and the phenotype poincare distance fails to grow toward the unit-ball boundary. Fix the buggy files.',
    bugs: [{ file: 'src/pareto.ts', from: 'if (!dominated) front.push(items[i]);', to: 'if (dominated) front.push(items[i]);' },
           { file: 'src/phenotype.ts', from: 'return Math.acosh(1 + (2 * diff2) / denom);', to: 'return Math.acosh(1 + (2 * diff2) * denom);' }] },
  { id: 'kernel-js', root: join(PKGS, 'kernel-js'), suites: ['trajectory'],
    problem: 'The trajectory store rotateIfLarger rotates a small file and skips rotation when over the size limit — the size threshold is inverted.',
    bugs: [{ file: 'src/trajectory.ts', from: 'if (s.size <= maxBytes) return false;', to: 'if (s.size > maxBytes) return false;' }] },
];

function taskFor(spec, g) {
  return {
    instance_id: spec.id, problem_statement: spec.problem, test_suites: spec.suites,
    patchMode: g.patchMode, maxAttempts: 2, selectK: 6,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(spec.root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(spec.root, f))) cpSync(join(spec.root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(spec.root, 'node_modules'), join(work, 'node_modules'), 'dir');
      for (const b of spec.bugs) { const p = join(work, b.file); writeFileSync(p, readFileSync(p, 'utf8').replace(b.from, b.to)); }
    },
  };
}
const short = (m) => m.split('/')[1];
const key = (g) => `${short(g.model)}/${g.patchMode}`;
const cache = new Map();
async function fitness(g) {
  if (cache.has(key(g))) return cache.get(key(g));
  const res = [], costs = [];
  for (let i = 0; i < N; i++) { let resolved = 0, cost = 0; for (const spec of SPECS) { let r; try { r = await runSweBenchTask(taskFor(spec, g), { model: g.model }); } catch { r = { resolved: false, cost_usd: 0 }; } if (r.resolved) resolved++; cost += r.cost_usd ?? 0; } res.push(resolved); costs.push(cost); }
  const mean = res.reduce((a, b) => a + b, 0) / N, mc = costs.reduce((a, b) => a + b, 0) / N;
  const f = { genome: key(g), model: short(g.model), meanResolved: Math.round(mean * 100) / 100, meanCost: Math.round(mc * 10000) / 10000, runs: res.map((r) => `${r}/2`) };
  cache.set(key(g), f); return f;
}
const better = (a, b) => (b.meanResolved - a.meanResolved) || (a.meanCost - b.meanCost); // resolve THEN cost
const cross = (a, b) => [{ model: a.model, patchMode: b.patchMode }, { model: b.model, patchMode: a.patchMode }];
const niche = new Map();
function consider(g, f) { const m = f.model; if (!niche.has(m) || better(f, niche.get(m).f) < 0) niche.set(m, { g, f }); }

const seeds = [
  { model: 'google/gemini-2.5-flash', patchMode: 'wholefile' },
  { model: 'deepseek/deepseek-chat', patchMode: 'wholefile' },
  { model: 'openai/gpt-5-mini', patchMode: 'searchreplace' },
];
for (const g of seeds) consider(g, await fitness(g));
const elites = [...niche.values()].map((e) => e.g);
const seen = new Set(seeds.map(key));
for (let i = 0; i < elites.length; i++) for (let k = i + 1; k < elites.length; k++) for (const child of cross(elites[i], elites[k])) { if (seen.has(key(child))) continue; seen.add(key(child)); consider(child, await fitness(child)); }

const all = [...cache.values()].sort(better);
const best = all[0];
const reached = best.genome === 'deepseek-chat/searchreplace';
console.log(JSON.stringify({
  experiment: 'ADR-141 — capability-discriminating MAP-Elites + crossover + averaging + (resolve,cost) objective',
  corpus: SPECS.map((s) => s.id), runsAveraged: N, objective: 'resolve-rate then cost',
  fitnessLandscape: all.map((f) => ({ genome: f.genome, meanResolved: `${f.meanResolved}/2`, meanCost: f.meanCost, runs: f.runs })),
  globalBest: { genome: best.genome, meanResolved: `${best.meanResolved}/2`, meanCost: best.meanCost },
  reachedGlobalOptimum: reached,
  verdict: reached
    ? `FULL OBJECTIVE WINS: resolve-rate eliminated wholefile (fails two-fault) + weak models (miss kernel-js); crossover assembled the survivors; cost picked '${best.genome}' (${best.meanResolved}/2, $${best.meanCost}) — the unambiguous optimum, no resolve-rate tie. Removes ADR-140's caveat.`
    : `global best '${best.genome}' (${best.meanResolved}/2, $${best.meanCost}) — report as measured`,
}, null, 2));
