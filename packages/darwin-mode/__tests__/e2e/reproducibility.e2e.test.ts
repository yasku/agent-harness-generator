// SPDX-License-Identifier: MIT
//
// ADR-075 acceptance — "reproduce the winning score from a clean checkout".
//
// Same fixture + same seed, run TWICE into two distinct work trees, must yield
// the identical winner identity (variant id), the identical winning finalScore,
// and the identical winner lineage. We compare the *decision* outputs, not the
// whole files, because the variants carry wall-clock `createdAt` timestamps —
// those are expected to differ; the EVOLUTION OUTCOME must not.
//
// A run with a DIFFERENT seed must still complete and stay safe (the winner may
// or may not differ — the deterministic mutator yields ties on this fixture, so
// we assert completion + safety rather than a forced divergence).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { evolve } from '../../src/evolve.js';
import { inspectVariant } from '../../src/safety.js';
import type { EvolutionConfig, EvolutionResult } from '../../src/types.js';
import { makeFixtureRepo, makeWorkRoot } from './fixtures/repo.js';

const BASE_CONFIG: Omit<EvolutionConfig, 'repoRoot' | 'workRoot' | 'seed'> = {
  generations: 2,
  childrenPerGeneration: 3,
  concurrency: 3,
  promotionDelta: 0.05,
  tasks: ['t1', 't2'],
};

describe('evolve — reproducibility (ADR-075)', () => {
  let repoRoot: string;
  let cleanRepo: () => Promise<void>;
  const workRoots: string[] = [];

  beforeEach(async () => {
    const fx = await makeFixtureRepo('darwin-repro');
    repoRoot = fx.repoRoot;
    cleanRepo = fx.cleanup;
  });

  afterEach(async () => {
    await Promise.all(workRoots.map((w) => rm(w, { recursive: true, force: true })));
    workRoots.length = 0;
    await cleanRepo();
  });

  async function runWithSeed(seed: number): Promise<EvolutionResult> {
    const workRoot = await makeWorkRoot('darwin-repro');
    workRoots.push(workRoot);
    return evolve({ ...BASE_CONFIG, repoRoot, workRoot, seed });
  }

  it('two runs with the SAME seed agree on the WINNER IDENTITY and lineage', async () => {
    const a = await runWithSeed(0);
    const b = await runWithSeed(0);

    expect(a.winner).not.toBeNull();
    expect(b.winner).not.toBeNull();

    // The decision outputs that ADR-073/075 hang the demo on are reproducible:
    // which variant won, and its full ancestral lineage.
    expect(b.winner!.variant.id).toBe(a.winner!.variant.id);
    expect(b.winnerLineage).toEqual(a.winnerLineage);

    // The whole archive's id ordering is reproducible (insertion order is
    // deterministic from the seed), which is what keeps archive.json stable.
    expect(b.records.map((r) => r.variant.id)).toEqual(
      a.records.map((r) => r.variant.id),
    );
  }, 30_000); // two full evolve runs back-to-back

  it('the score terms that DO NOT depend on wall-clock are reproducible', async () => {
    const a = await runWithSeed(0);
    const b = await runWithSeed(0);

    // Everything except latencyEfficiency (and therefore baseScore/finalScore)
    // is a pure function of the deterministic traces, so it must match exactly.
    const stable = (r: EvolutionResult) =>
      r.records.map((rec) => ({
        id: rec.variant.id,
        taskSuccess: rec.score!.taskSuccess,
        testPassRate: rec.score!.testPassRate,
        traceQuality: rec.score!.traceQuality,
        costEfficiency: rec.score!.costEfficiency,
        safetyScore: rec.score!.safetyScore,
        secretExposure: rec.score!.secretExposure,
        destructiveAction: rec.score!.destructiveAction,
        hallucinatedFile: rec.score!.hallucinatedFile,
        toolLoop: rec.score!.toolLoop,
        promoted: rec.score!.promoted,
      }));

    expect(stable(b)).toEqual(stable(a));
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // The winning SCORE is byte-reproducible (ADR-075 acceptance bar).
  //
  // This previously failed: the scorer folded wall-clock `durationMs` into
  // `latencyEfficiency`, so `finalScore` drifted between two same-seed runs by a
  // timing-dependent epsilon. `scorer.ts` now scores latency (and cost) as
  // DETERMINISTIC prototype hooks — at prototype level every variant runs the
  // identical test command, so per-variant wall-clock is pure noise — and rounds
  // every score field to 6dp. The result is a frozen scorer that is a pure
  // function of deterministic inputs: same seed ⇒ identical finalScore.
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'winning finalScore is byte-reproducible across same-seed runs',
    async () => {
      const a = await runWithSeed(0);
      const b = await runWithSeed(0);
      expect(b.winner!.score!.finalScore).toBe(a.winner!.score!.finalScore);
      expect(b.winner!.score!.baseScore).toBe(a.winner!.score!.baseScore);
    },
    30_000,
  );

  it('a run with a DIFFERENT seed still completes and stays safe', async () => {
    const a = await runWithSeed(0);
    const c = await runWithSeed(123);

    // Completion: a winner and a populated archive.
    expect(c.winner).not.toBeNull();
    expect(c.records.length).toBe(a.records.length);

    // Safety holds regardless of seed (the gate is seed-independent).
    for (const record of c.records) {
      const findings = await inspectVariant(record.variant.dir);
      expect(findings).toEqual([]);
      expect(record.score!.safetyScore).toBe(1.0);
    }
    // The winner is reproducibly scored within its own run (no NaN, finite).
    expect(Number.isFinite(c.winner!.score!.finalScore)).toBe(true);
  }, 30_000); // two full evolve runs back-to-back
});
