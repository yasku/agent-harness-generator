// SPDX-License-Identifier: MIT
//
// Hyperbolic behavioral phenotyping (ADR-091). MAP-Elites (ADR-088) bins variants
// by a FLAT structural axis (which of the 7 surfaces was mutated). But real agent
// behaviour is HIERARCHICAL — deep recursive backtracking vs. shallow linear tool
// use — and hierarchies embed far more faithfully in hyperbolic space than in a
// flat categorical grid.
//
// We distil a variant's run traces into a behaviour feature vector, embed it in
// the 2-D Poincaré ball (radius ≈ hierarchical "depth/struggle", angle ≈
// behavioural mode), and assign a niche by hyperbolic region. The result plugs
// straight into `Archive.selectElites(limit, descriptorOf)` as the descriptor.
//
// Dependency-free and closed-form. NOTE on RuVector: `ruvector-wasm@2.1.x`
// exposes a `VectorDB`/`HNSW` with euclidean/cosine/dotproduct/manhattan metrics
// only — it has NO hyperbolic metric — so the Poincaré geometry is computed here
// natively. A RuVector HNSW index can later back nearest-niche lookups at scale,
// but the hyperbolic phenotyping itself does not depend on it.

import type { RunTrace } from './types.js';

/** Squash a non-negative magnitude into [0, 1) — a smooth, bounded saturation. */
function squash(x: number): number {
  return Math.tanh(Math.max(0, x));
}

/** Fraction of lines that are exact repeats — a proxy for loops / backtracking. */
function repetitionFraction(text: string): number {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return 0;
  const seen = new Set<string>();
  let repeats = 0;
  for (const l of lines) {
    if (seen.has(l)) repeats += 1;
    else seen.add(l);
  }
  return repeats / lines.length;
}

/**
 * A small, bounded behaviour feature vector for one variant's traces. Each field
 * is in [0, 1]. Pure and deterministic (no wall-clock beyond the recorded
 * durations, which only affect `durationSpread`, a relative quantity).
 */
export interface BehaviorFeatures {
  /** Fraction of traces that failed (non-zero exit, timeout, or safety block). */
  failRate: number;
  /** Fraction that hit the wall-clock timeout (a deep-loop signature). */
  timeoutRate: number;
  /** Fraction that tripped a safety block. */
  blockRate: number;
  /** Output verbosity, saturated (mean stdout+stderr chars). */
  verbosity: number;
  /** Repeated-line fraction across traces — loop / backtracking proxy. */
  repetition: number;
  /** Relative duration spread (stddev/mean) — irregular vs. uniform effort. */
  durationSpread: number;
}

export function behaviorFeatures(traces: RunTrace[]): BehaviorFeatures {
  const n = traces.length;
  if (n === 0) {
    return { failRate: 0, timeoutRate: 0, blockRate: 0, verbosity: 0, repetition: 0, durationSpread: 0 };
  }
  let fails = 0, timeouts = 0, blocks = 0, charsSum = 0, repSum = 0;
  const durs: number[] = [];
  for (const t of traces) {
    const failed = t.exitCode !== 0 || t.timedOut || t.blockedActions.length > 0;
    if (failed) fails += 1;
    if (t.timedOut) timeouts += 1;
    if (t.blockedActions.length > 0) blocks += 1;
    const out = `${t.stdout}\n${t.stderr}`;
    charsSum += out.length;
    repSum += repetitionFraction(out);
    durs.push(t.durationMs);
  }
  const mean = durs.reduce((s, d) => s + d, 0) / n;
  const variance = durs.reduce((s, d) => s + (d - mean) ** 2, 0) / n;
  const durationSpread = mean > 0 ? squash(Math.sqrt(variance) / mean) : 0;
  return {
    failRate: fails / n,
    timeoutRate: timeouts / n,
    blockRate: blocks / n,
    verbosity: squash(charsSum / n / 2000),
    repetition: Math.min(1, repSum / n),
    durationSpread,
  };
}

/**
 * Embed behaviour features into the 2-D Poincaré ball (the open unit disk).
 * RADIUS encodes hierarchical "depth/struggle" (failure, looping, timeouts) —
 * deep recursive strugglers sit near the boundary where hyperbolic distance
 * explodes; clean shallow agents sit near the origin. ANGLE encodes behavioural
 * MODE (verbosity vs. safety-pressure vs. effort irregularity). The point always
 * satisfies ‖p‖ < 1.
 */
export function poincareEmbed(f: BehaviorFeatures): [number, number] {
  const depth = squash(1.6 * f.failRate + 1.2 * f.repetition + 1.0 * f.timeoutRate);
  const radius = Math.min(0.999, depth); // keep strictly inside the open ball
  // Angle from the behavioural-mode features, wrapped into [0, 2π).
  const modeRaw = 0.6 * f.verbosity + 1.0 * f.blockRate + 0.4 * f.durationSpread;
  const theta = (modeRaw % 1) * 2 * Math.PI;
  return [radius * Math.cos(theta), radius * Math.sin(theta)];
}

/**
 * Poincaré-ball distance between two points in the open unit ball:
 *
 *   d(u,v) = acosh( 1 + 2 · ‖u−v‖² / ((1−‖u‖²)(1−‖v‖²)) )
 *
 * Returns 0 for identical points, is symmetric, and grows without bound as
 * either point approaches the boundary. Guards the denominator for points placed
 * exactly on the boundary (treated as just inside).
 */
export function poincareDistance(u: readonly number[], v: readonly number[]): number {
  let diff2 = 0, nu2 = 0, nv2 = 0;
  for (let i = 0; i < u.length; i++) {
    diff2 += (u[i] - v[i]) ** 2;
    nu2 += u[i] ** 2;
    nv2 += v[i] ** 2;
  }
  const denom = Math.max(1e-12, (1 - Math.min(1, nu2)) * (1 - Math.min(1, nv2)));
  return Math.acosh(1 + (2 * diff2) / denom);
}

/**
 * Assign a discrete behavioural niche by hyperbolic region: a radial shell
 * (hierarchy depth) crossed with an angular sector (behavioural mode). Same
 * behaviour ⇒ same niche; deterministic. Plugs into `selectElites` as the
 * descriptor: `selectElites(k, v => behavioralNiche(tracesById.get(v.id) ?? []))`.
 */
export function behavioralNiche(traces: RunTrace[], shells = 4, sectors = 6): string {
  const [x, y] = poincareEmbed(behaviorFeatures(traces));
  const r = Math.sqrt(x * x + y * y);
  const shell = Math.min(shells - 1, Math.floor(r * shells));
  let theta = Math.atan2(y, x);
  if (theta < 0) theta += 2 * Math.PI;
  const sector = Math.min(sectors - 1, Math.floor((theta / (2 * Math.PI)) * sectors));
  return `h${shell}_s${sector}`;
}

// ── Active niche steering (ADR-092) — navigate the behavioural manifold ───────
//
// Diversity selection (ADR-091) MAINTAINS spread. Steering actively DRIVES the
// population toward under-explored regions of the Poincaré ball: find a density
// hole (preferring the high-radius "complex / deep-thinking" frontier), then seed
// the next generation from the survivors nearest that hole, so their offspring
// land in or near it. The whole mechanism is closed-form + deterministic.

/** Geometric centroid of niche cell `(shell, sector)` in the Poincaré disk. */
export function nicheCentroid(shell: number, sector: number, shells = 4, sectors = 6): [number, number] {
  const r = (shell + 0.5) / shells;
  const theta = ((sector + 0.5) / sectors) * 2 * Math.PI;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/**
 * Find an under-explored target niche: scan shells from the OUTSIDE in (prefer
 * the high-radius complexity frontier, per open-endedness) and return the first
 * unoccupied cell's id + centroid. Returns `null` when every niche is occupied.
 */
export function underExploredTarget(
  occupied: ReadonlySet<string>,
  shells = 4,
  sectors = 6,
): { niche: string; centroid: [number, number] } | null {
  for (let shell = shells - 1; shell >= 0; shell--) {
    for (let sector = 0; sector < sectors; sector++) {
      const niche = `h${shell}_s${sector}`;
      if (!occupied.has(niche)) return { niche, centroid: nicheCentroid(shell, sector, shells, sectors) };
    }
  }
  return null;
}

/**
 * Rank candidates by Poincaré distance to `target` (ascending) and return the
 * nearest `limit` ids — the survivors whose offspring are most likely to reach
 * the under-explored region. Ties break by the candidate array order (the caller
 * supplies a deterministic order, e.g. archive insertion).
 */
export function nearestToTarget(
  candidates: ReadonlyArray<{ id: string; embed: readonly [number, number] }>,
  target: readonly [number, number],
  limit: number,
): string[] {
  if (limit <= 0) return [];
  return candidates
    .map((c, i) => ({ id: c.id, d: poincareDistance(c.embed, target), i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, limit)
    .map((c) => c.id);
}

/** Convenience: the Poincaré embedding of a variant straight from its traces. */
export function embedTraces(traces: RunTrace[]): [number, number] {
  return poincareEmbed(behaviorFeatures(traces));
}
