// SPDX-License-Identifier: MIT
//
// End-to-end: the WHOLE `evolve` loop against a throwaway fixture repo.
//
// Asserts the ADR-070 work-tree contract (archive.json, lineage.json,
// reports/winner.json, runs/baseline.json + one run file per variant, and a
// variants/<id>/ directory per variant) and the structural invariants of the
// result: a baseline, a winner, a valid winner lineage rooted at the baseline,
// and an archive that is a TREE (every non-baseline variant has a parent in it).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { evolve } from '../../src/evolve.js';
import type { EvolutionResult } from '../../src/types.js';
import { makeFixture, type Fixture } from './fixtures/repo.js';

/** True if `path` exists and is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** True if `path` exists and is a directory. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe('evolve — end-to-end loop + work-tree contract', () => {
  let fx: Fixture;
  let result: EvolutionResult;

  beforeEach(async () => {
    fx = await makeFixture('darwin-evolve');
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

  it('writes the ADR-070 work tree (archive, lineage, winner report, runs, variants)', async () => {
    const wr = fx.workRoot;

    expect(await isFile(join(wr, 'archive.json'))).toBe(true);
    expect(await isFile(join(wr, 'lineage.json'))).toBe(true);
    expect(await isFile(join(wr, 'reports', 'winner.json'))).toBe(true);
    expect(await isFile(join(wr, 'runs', 'baseline.json'))).toBe(true);

    // One run file and one variant directory per record in the archive.
    for (const record of result.records) {
      const id = record.variant.id;
      expect(await isFile(join(wr, 'runs', `${id}.json`))).toBe(true);
      expect(await isDir(join(wr, 'variants', id))).toBe(true);
    }

    // The baseline variant directory exists too.
    expect(await isDir(join(wr, 'variants', 'baseline'))).toBe(true);
  });

  it('each run file carries traces (one per task) and a scorecard', async () => {
    for (const record of result.records) {
      const raw = await readFile(
        join(fx.workRoot, 'runs', `${record.variant.id}.json`),
        'utf8',
      );
      const parsed = JSON.parse(raw) as {
        traces: Array<{ taskId: string }>;
        score: { variantId: string };
      };
      expect(parsed.traces.map((t) => t.taskId)).toEqual(['t1', 't2']);
      expect(parsed.score.variantId).toBe(record.variant.id);
    }
  });

  it('reports/winner.json on disk matches result.winner', async () => {
    const raw = await readFile(
      join(fx.workRoot, 'reports', 'winner.json'),
      'utf8',
    );
    const onDisk = JSON.parse(raw) as { variant: { id: string } } | null;
    expect(onDisk).not.toBeNull();
    expect(result.winner).not.toBeNull();
    expect(onDisk?.variant.id).toBe(result.winner?.variant.id);
  });

  it('returns a baseline, a winner, and a winner lineage rooted at the baseline', () => {
    expect(result.baseline.variant.id).toBe('baseline');
    expect(result.baseline.score).not.toBeNull();

    expect(result.winner).not.toBeNull();
    expect(result.winnerLineage.length).toBeGreaterThan(0);
    // ADR-073: the winning lineage starts at the baseline.
    expect(result.winnerLineage[0]).toBe(result.baseline.variant.id);
    // ...and ends at the winner.
    expect(result.winnerLineage[result.winnerLineage.length - 1]).toBe(
      result.winner?.variant.id,
    );
  });

  it('the winner lineage is a valid parent chain through the archive', () => {
    const byId = new Map(result.records.map((r) => [r.variant.id, r]));
    const lineage = result.winnerLineage;

    // Every id in the lineage is a real archive record.
    for (const id of lineage) {
      expect(byId.has(id)).toBe(true);
    }
    // Each step is the parent of the next (walking root → winner).
    for (let i = 1; i < lineage.length; i++) {
      const child = byId.get(lineage[i])!;
      expect(child.variant.parentId).toBe(lineage[i - 1]);
    }
    // The root of the lineage has no parent.
    expect(byId.get(lineage[0])!.variant.parentId).toBeNull();
  });

  it('the archive is a TREE: every non-baseline variant has a parent in the archive', () => {
    const ids = new Set(result.records.map((r) => r.variant.id));

    let nonBaseline = 0;
    for (const record of result.records) {
      const { variant } = record;
      if (variant.parentId === null) {
        // The only parentless node is the baseline (generation 0).
        expect(variant.id).toBe('baseline');
        expect(variant.generation).toBe(0);
        continue;
      }
      nonBaseline += 1;
      // The parent must exist in the archive (no dangling edges).
      expect(ids.has(variant.parentId)).toBe(true);
      // And the parent must list this variant as a child (tree edge wired).
      const parent = result.records.find((r) => r.variant.id === variant.parentId)!;
      expect(parent.children).toContain(variant.id);
    }

    // gen 1: 3 children of baseline; gen 2: 3 children per gen-1 parent.
    expect(nonBaseline).toBeGreaterThanOrEqual(3);
  });

  it('lineage.json renders a well-formed graph from the archive alone (ADR-073)', async () => {
    const raw = await readFile(join(fx.workRoot, 'lineage.json'), 'utf8');
    const graph = JSON.parse(raw) as {
      nodes: Array<{ id: string; parentId: string | null }>;
      edges: Array<{ from: string; to: string }>;
    };
    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    expect(graph.nodes.length).toBe(result.records.length);
    // Every edge connects two existing nodes (well-formed graph).
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });
});
