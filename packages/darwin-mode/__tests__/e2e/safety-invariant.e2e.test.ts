// SPDX-License-Identifier: MIT
//
// THE load-bearing e2e property (ADR-070/071/075 — "zero unsafe actions"):
// after a full evolution run, NOTHING the loop produced is unsafe.
//
//   1. Every variant directory the run wrote (baseline + every child) passes
//      `inspectVariant` — i.e. inspectVariant(dir) === [] for all of them.
//   2. Across EVERY run trace on disk, blockedActions is empty and no trace
//      carries the reserved disqualification exitCode 99.
//
// If the deterministic mutator (or any future generator behind the same gate)
// ever emitted a directory that tripped the ADR-071 allowlist/content gate,
// this test fails — which is exactly the acceptance bar.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evolve } from '../../src/evolve.js';
import { inspectVariant } from '../../src/safety.js';
import type { EvolutionResult, RunTrace } from '../../src/types.js';
import { makeFixture, type Fixture } from './fixtures/repo.js';

/** The reserved exit code the sandbox uses for a gate-disqualified variant. */
const DISQUALIFIED_EXIT_CODE = 99;

describe('evolve — safety invariant (zero unsafe actions)', () => {
  let fx: Fixture;
  let result: EvolutionResult;

  beforeEach(async () => {
    fx = await makeFixture('darwin-safety');
    result = await evolve({
      repoRoot: fx.repoRoot,
      workRoot: fx.workRoot,
      generations: 2,
      childrenPerGeneration: 3,
      concurrency: 3,
      seed: 0,
      promotionDelta: 0.05,
      tasks: ['t1', 't2'],
    });
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('every produced variant directory passes inspectVariant (findings === [])', async () => {
    expect(result.records.length).toBeGreaterThan(0);

    for (const record of result.records) {
      const findings = await inspectVariant(record.variant.dir);
      expect(
        findings,
        `variant ${record.variant.id} produced unsafe findings: ${findings.join('; ')}`,
      ).toEqual([]);
    }
  });

  it('the baseline directory itself is clean', async () => {
    const findings = await inspectVariant(join(fx.workRoot, 'variants', 'baseline'));
    expect(findings).toEqual([]);
  });

  it('NO run trace on disk has blocked actions or the exitCode-99 disqualification', async () => {
    let totalTraces = 0;

    for (const record of result.records) {
      const raw = await readFile(
        join(fx.workRoot, 'runs', `${record.variant.id}.json`),
        'utf8',
      );
      const { traces } = JSON.parse(raw) as { traces: RunTrace[] };
      expect(traces.length).toBeGreaterThan(0);

      for (const trace of traces) {
        totalTraces += 1;
        expect(
          trace.blockedActions,
          `variant ${record.variant.id} task ${trace.taskId} blocked: ${trace.blockedActions.join('; ')}`,
        ).toEqual([]);
        expect(trace.exitCode).not.toBe(DISQUALIFIED_EXIT_CODE);
      }
    }

    // Sanity: we actually inspected traces (not a vacuous pass).
    expect(totalTraces).toBeGreaterThan(0);
  });

  it('every scorecard reports a perfect safetyScore and no safety penalties', async () => {
    for (const record of result.records) {
      const score = record.score;
      expect(score).not.toBeNull();
      // ADR-072: a clean run scores safetyScore 1.0 with zero hard penalties.
      expect(score!.safetyScore).toBe(1.0);
      expect(score!.secretExposure).toBe(0);
      expect(score!.destructiveAction).toBe(0);
      expect(score!.hallucinatedFile).toBe(0);
      expect(score!.toolLoop).toBe(0);
    }
  });
});
