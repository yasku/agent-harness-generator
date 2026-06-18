// SPDX-License-Identifier: MIT
//
// Tests for hyperbolic behavioral phenotyping (ADR-091): the Poincaré geometry
// is correct (metric axioms + boundary blow-up), the embedding stays inside the
// open ball, and distinct behaviours land in distinct hyperbolic niches.

import { describe, expect, it } from 'vitest';
import {
  behaviorFeatures,
  poincareEmbed,
  poincareDistance,
  behavioralNiche,
  nicheCentroid,
  underExploredTarget,
  nearestToTarget,
} from '../src/phenotype.js';
import type { RunTrace } from '../src/types.js';

function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    variantId: 'v', taskId: 't', startedAt: '', finishedAt: '', exitCode: 0,
    stdout: '', stderr: '', durationMs: 100, timedOut: false, blockedActions: [],
    ...over,
  };
}

describe('poincareDistance (metric axioms)', () => {
  it('is zero for identical points', () => {
    expect(poincareDistance([0.2, 0.3], [0.2, 0.3])).toBeCloseTo(0, 12);
  });

  it('is symmetric and positive for distinct points', () => {
    const a = [0.1, 0.0], b = [0.4, 0.2];
    expect(poincareDistance(a, b)).toBeGreaterThan(0);
    expect(poincareDistance(a, b)).toBeCloseTo(poincareDistance(b, a), 12);
  });

  it('blows up toward the boundary (same Euclidean gap costs more near the edge)', () => {
    const near = poincareDistance([0.0, 0], [0.1, 0]);
    const edge = poincareDistance([0.88, 0], [0.98, 0]);
    expect(edge).toBeGreaterThan(near * 3); // hyperbolic expansion near ‖p‖→1
  });
});

describe('poincareEmbed', () => {
  it('always lands strictly inside the open unit ball', () => {
    const extreme = poincareEmbed({
      failRate: 1, timeoutRate: 1, blockRate: 1, verbosity: 1, repetition: 1, durationSpread: 1,
    });
    const norm = Math.hypot(extreme[0], extreme[1]);
    expect(norm).toBeLessThan(1);
  });

  it('clean behaviour sits near the origin; struggling behaviour near the boundary', () => {
    const clean = poincareEmbed(behaviorFeatures([trace(), trace()]));
    const struggling = poincareEmbed(behaviorFeatures([
      trace({ exitCode: 1, timedOut: true, stdout: 'retry\nretry\nretry\nretry' }),
      trace({ exitCode: 1, timedOut: true, stdout: 'loop\nloop\nloop' }),
    ]));
    expect(Math.hypot(...clean)).toBeLessThan(Math.hypot(...struggling));
  });
});

describe('behavioralNiche', () => {
  it('is deterministic for the same behaviour', () => {
    const ts = [trace({ exitCode: 1, stdout: 'a\na\nb' })];
    expect(behavioralNiche(ts)).toBe(behavioralNiche(ts));
  });

  it('separates a deep recursive struggler from a clean shallow agent', () => {
    const shallow = behavioralNiche([trace(), trace()]);
    const deep = behavioralNiche([
      trace({ exitCode: 1, timedOut: true, stdout: 'x\nx\nx\nx\nx' }),
      trace({ exitCode: 1, timedOut: true, stdout: 'y\ny\ny\ny' }),
    ]);
    expect(shallow).not.toBe(deep);
  });

  it('empty traces map to a stable origin niche', () => {
    expect(behavioralNiche([])).toBe(behavioralNiche([]));
  });
});

describe('active niche steering (ADR-092)', () => {
  it('nicheCentroid lands inside the cell it names', () => {
    const shells = 4, sectors = 6;
    for (let s = 0; s < shells; s++) {
      for (let k = 0; k < sectors; k++) {
        const [x, y] = nicheCentroid(s, k, shells, sectors);
        const r = Math.hypot(x, y);
        expect(Math.floor(r * shells)).toBe(s); // back-maps to the same shell
        expect(r).toBeLessThan(1);
      }
    }
  });

  it('underExploredTarget prefers the high-radius (complexity) frontier', () => {
    // Occupy everything EXCEPT one outer cell and one inner cell.
    const shells = 4, sectors = 6;
    const all: string[] = [];
    for (let s = 0; s < shells; s++) for (let k = 0; k < sectors; k++) all.push(`h${s}_s${k}`);
    const occupied = new Set(all.filter((n) => n !== 'h3_s2' && n !== 'h0_s4'));
    const target = underExploredTarget(occupied, shells, sectors);
    expect(target!.niche).toBe('h3_s2'); // outermost hole chosen over the inner one
  });

  it('underExploredTarget returns null when the manifold is full', () => {
    const shells = 2, sectors = 2;
    const occupied = new Set(['h0_s0', 'h0_s1', 'h1_s0', 'h1_s1']);
    expect(underExploredTarget(occupied, shells, sectors)).toBeNull();
  });

  it('nearestToTarget returns the candidates closest in Poincaré distance', () => {
    const target: [number, number] = [0.8, 0];
    const candidates = [
      { id: 'far', embed: [0.0, 0.0] as [number, number] },
      { id: 'near', embed: [0.75, 0.0] as [number, number] },
      { id: 'mid', embed: [0.4, 0.0] as [number, number] },
    ];
    expect(nearestToTarget(candidates, target, 2)).toEqual(['near', 'mid']);
  });
});
