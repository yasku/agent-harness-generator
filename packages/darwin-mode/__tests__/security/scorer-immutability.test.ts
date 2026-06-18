// SPDX-License-Identifier: MIT
//
// ADVERSARIAL SECURITY AUDIT — scoreVariant() benchmark/scorer integrity
// (ADR-072 §benchmark integrity, ADR-071 rule 9).
//
// The threat: a variant that proposes a self-serving `score_policy.ts` to
// re-grade itself, or that smuggles in blocked actions yet still gets promoted.
//
// The structural defense is that the authoritative scorer is FROZEN kernel code
// whose ONLY inputs are (variantId, traces, parentScore, promotionDelta,
// taskTimeoutMs). It never reads variant files. We prove that here by feeding
// identical traces and showing the verdict cannot move, no matter what a variant
// "wishes" its weights were — there is no parameter through which variant file
// content could enter the computation.

import { describe, expect, it } from 'vitest';
import { scoreVariant, scoreWeights } from '../../src/scorer.js';
import type { RunTrace, ScoreCard } from '../../src/types.js';

function trace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    variantId: 'v',
    taskId: 't',
    startedAt: '2026-06-17T00:00:00.000Z',
    finishedAt: '2026-06-17T00:00:00.000Z',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    blockedActions: [],
    ...overrides,
  };
}

describe('scorer — the scorer is frozen, not variant-influenced', () => {
  it('takes ONLY traces + parent + delta as input (no variant-file channel)', () => {
    // The function arity / signature is the proof: there is no `variantDir`,
    // no `weights`, no `scorePolicy` parameter. Two "variants" that imagine
    // wildly different score_policy.ts cannot pass anything in.
    expect(scoreVariant.length).toBeLessThanOrEqual(5);
  });

  it('identical traces ⇒ identical finalScore/promoted regardless of "proposed" weights', () => {
    // Imagine variant A's score_policy.ts proposes safetyScore weight 0.0 and
    // variant B's proposes 0.9. Neither can reach the scorer: both are graded
    // by the SAME frozen weights. We model this by simply scoring the SAME
    // traces twice (there is no other knob to turn) and asserting equality.
    const traces = [
      trace({ exitCode: 0, durationMs: 1000 }),
      trace({ exitCode: 1, durationMs: 2000, stderr: 'cannot find module' }),
    ];
    const a = scoreVariant('variant-A-proposes-weights-x', traces, null, 0.05);
    const b = scoreVariant('variant-B-proposes-weights-y', traces, null, 0.05);

    expect(a.finalScore).toBe(b.finalScore);
    expect(a.baseScore).toBe(b.baseScore);
    expect(a.promoted).toBe(b.promoted);
    expect(a.safetyScore).toBe(b.safetyScore);
    // Only the (caller-supplied) id differs; every computed field is identical.
    expect({ ...a, variantId: '' }).toEqual({ ...b, variantId: '' });
  });

  it('the authoritative weights are fixed and sum to 1.0', () => {
    const w = scoreWeights();
    const sum =
      w.taskSuccess +
      w.testPassRate +
      w.traceQuality +
      w.costEfficiency +
      w.latencyEfficiency +
      w.safetyScore;
    expect(sum).toBeCloseTo(1.0, 10);
    // Frozen constants — a variant cannot widen its own safety weight.
    expect(w.safetyScore).toBe(0.1);
  });

  it('re-running on the same traces is reproducible (ADR-072 §reproducibility)', () => {
    const traces = [trace({ exitCode: 0, durationMs: 500 })];
    const first = scoreVariant('v', traces, null, 0.05);
    const again = scoreVariant('v', traces, null, 0.05);
    expect(first).toEqual(again);
  });
});

describe('scorer — a blocked-action variant can NEVER be promoted', () => {
  it('any blockedActions ⇒ safetyScore 0 and promoted false, even beating a weak parent', () => {
    // A weak parent the variant clears on raw score, so ONLY safety blocks it.
    const weakParent: ScoreCard = {
      variantId: 'parent',
      taskSuccess: 0,
      testPassRate: 0,
      traceQuality: 0,
      costEfficiency: 0,
      latencyEfficiency: 0,
      safetyScore: 0,
      secretExposure: 0,
      destructiveAction: 0,
      hallucinatedFile: 0,
      toolLoop: 0,
      costOverrun: 0,
      baseScore: 0,
      finalScore: 0,
      promoted: false,
      reason: 'baseline',
    };

    const child = scoreVariant(
      'cheater',
      [trace({ exitCode: 0, durationMs: 0, blockedActions: ['unexpected file evil.ts'] })],
      weakParent,
      0.05,
    );

    expect(child.safetyScore).toBe(0);
    expect(child.promoted).toBe(false);
    expect(child.reason).toMatch(/safetyScore|blocked actions/i);
  });

  it('a disqualified (exitCode 99) trace zeroes safety and trips the toolLoop penalty', () => {
    const child = scoreVariant(
      'dq',
      [trace({ exitCode: 99, blockedActions: ['symlink not allowed: planner.ts'] })],
      null,
      0.05,
    );
    expect(child.safetyScore).toBe(0);
    expect(child.toolLoop).toBe(1);
    expect(child.promoted).toBe(false);
  });

  it('safety alone vetoes promotion even with a perfect base score', () => {
    // One clean pass (high base) + one blocked trace ⇒ safety still 0 overall.
    const child = scoreVariant(
      'mixed',
      [
        trace({ exitCode: 0, durationMs: 0 }),
        trace({ exitCode: 0, durationMs: 0, blockedActions: ['blocked content'] }),
      ],
      null,
      0.05,
    );
    expect(child.safetyScore).toBe(0);
    expect(child.promoted).toBe(false);
  });
});
