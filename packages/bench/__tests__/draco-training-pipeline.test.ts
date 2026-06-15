// SPDX-License-Identifier: MIT
//
// CI guard (ADR-043) — the KRR training pipeline trains a working router from the
// committed routing dataset and lands in the measured band. Locks the trained
// router against regression on REAL data: it must keep clearing the best fixed
// model's noise floor and not collapse. Offline (committed JSON, no API).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { trainRouter, TrainedRouter } from '@metaharness/router';

const DS = join(dirname(fileURLToPath(import.meta.url)), '..', 'draco', 'runs', 'routing-dataset.json');

describe.skipIf(!existsSync(DS))('DRACO training pipeline — KRR on the committed dataset', () => {
  const ds = JSON.parse(readFileSync(DS, 'utf8')) as {
    prices: Record<string, number>;
    models: string[];
    rows: { embedding: number[]; scores: Record<string, number> }[];
  };
  const oracle =
    ds.rows.reduce((s, r) => s + Math.max(...ds.models.map((m) => r.scores[m])), 0) / ds.rows.length;
  const bestFixed = Math.max(
    ...ds.models.map((m) => ds.rows.reduce((s, r) => s + r.scores[m], 0) / ds.rows.length),
  );

  it('trains and reports a LOO quality in the measured band (data-ceiling tie)', () => {
    const { router, lambda, looQuality } = trainRouter(ds.rows, ds.prices);
    expect(lambda).toBeGreaterThan(0);
    // ties the best fixed model (within noise) and does not collapse to the mean.
    expect(looQuality).toBeGreaterThan(bestFixed - 0.02);
    expect(looQuality).toBeLessThan(oracle + 1e-9);
    expect(router).toBeInstanceOf(TrainedRouter);
  });

  it('the trained model serialises and routes deterministically', () => {
    const { router } = trainRouter(ds.rows, ds.prices, { qualityBar: 0.7 });
    const reloaded = TrainedRouter.fromJSON(JSON.parse(JSON.stringify(router.toJSON())));
    const q = ds.rows[0].embedding;
    expect(reloaded.route(q).id).toBe(router.route(q).id);
  });
});
