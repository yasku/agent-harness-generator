// SPDX-License-Identifier: MIT
//
// Tests for the evolve() pure helpers. The 'faster' tie-break (ADR-072 scorer
// is ceiling-bound, so finalScore ties are the norm) must, among the variants
// sharing the top finalScore, pick the most efficient one by mean trace ms —
// and must never let a higher-scoring-but-slower variant lose, nor a
// lower-scoring-but-faster one win.

import { describe, expect, it } from 'vitest';
import { pickEfficientWinner, mapLimit } from '../src/evolve.js';
import type { ArchiveRecord, RunTrace, ScoreCard } from '../src/types.js';

function card(finalScore: number): ScoreCard {
  return {
    variantId: 'x', taskSuccess: 1, testPassRate: 1, traceQuality: 0.9,
    costEfficiency: 1, latencyEfficiency: 1, safetyScore: 1,
    secretExposure: 0, destructiveAction: 0, hallucinatedFile: 0, toolLoop: 0, costOverrun: 0,
    baseScore: finalScore, finalScore, promoted: false, reason: 'test',
  };
}
function rec(id: string, finalScore: number | null): ArchiveRecord {
  return {
    variant: {
      id, parentId: null, generation: 0, dir: `/tmp/${id}`,
      mutationSurface: 'planner', mutationSummary: 's', createdAt: '2026-01-01T00:00:00Z',
    },
    score: finalScore === null ? null : { ...card(finalScore), variantId: id },
    children: [],
  };
}
function traces(id: string, ms: number): RunTrace[] {
  return [{
    variantId: id, taskId: 't', startedAt: '', finishedAt: '', exitCode: 0,
    stdout: '', stderr: '', durationMs: ms, timedOut: false, blockedActions: [],
  }];
}

describe('pickEfficientWinner', () => {
  it('returns null when no record is scored', () => {
    expect(pickEfficientWinner([rec('a', null), rec('b', null)], new Map())).toBeNull();
  });

  it('among equal top finalScore, picks the lowest mean trace ms', () => {
    const recs = [rec('slow', 0.985), rec('fast', 0.985), rec('mid', 0.985)];
    const t = new Map([
      ['slow', traces('slow', 900)],
      ['fast', traces('fast', 100)],
      ['mid', traces('mid', 500)],
    ]);
    expect(pickEfficientWinner(recs, t)!.variant.id).toBe('fast');
  });

  it('never sacrifices finalScore for speed (a faster lower-score variant cannot win)', () => {
    const recs = [rec('best', 0.985), rec('speedy', 0.5)];
    const t = new Map([
      ['best', traces('best', 800)],
      ['speedy', traces('speedy', 1)],
    ]);
    expect(pickEfficientWinner(recs, t)!.variant.id).toBe('best');
  });

  it('treats a variant with no traces as least efficient (Infinity)', () => {
    const recs = [rec('untimed', 0.985), rec('timed', 0.985)];
    const t = new Map([['timed', traces('timed', 700)]]);
    expect(pickEfficientWinner(recs, t)!.variant.id).toBe('timed');
  });
});

describe('mapLimit', () => {
  it('preserves order and bounds concurrency', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
