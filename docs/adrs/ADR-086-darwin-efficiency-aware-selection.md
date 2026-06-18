# ADR-086: Darwin Mode — opt-in efficiency-aware selection (a gradient above the scorer ceiling)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-072 (lightweight scorer + promotion gate), ADR-073 (archive + selection), ADR-075 (reproducibility clause), ADR-084 (failure-driven mutation), ADR-076 (rigorous benchmark layer)

> A measured fact about ADR-072's scorer: every safe, test-passing variant earns `finalScore = 0.985`. The scorer is a correctness/safety **gate**, not a quality discriminator — so `archive.best()` picks among ceiling-tied variants by insertion order, which is arbitrary. This ADR adds an **opt-in** tie-break that gives selection a real efficiency gradient without touching the frozen, reproducible scorer.

## Context

The lightweight scorer (ADR-072) weights `taskSuccess 0.35 + testPassRate 0.20 + traceQuality 0.15 + costEfficiency 0.10 + latencyEfficiency 0.10 + safetyScore 0.10`. Per ADR-075's reproducibility clause, `costEfficiency` and `latencyEfficiency` are stubbed to `1.0` (absolute wall-clock/cost are not reproducible), and `traceQuality` binary-caps at `0.9`. The arithmetic ceiling for any clean variant is therefore:

```
0.35 + 0.20 + 0.9·0.15 + 0.10 + 0.10 + 0.10 = 0.985
```

This was confirmed empirically (deterministic and LLM mutators both produce winners at exactly `0.985`; see `bench/results/evolve-mutator-parity.json`). The consequence: among the variants that matter — the safe, passing ones — `finalScore` cannot rank them. `archive.best()` falls back to insertion order. Evolution has a gate but no gradient.

We deliberately do **not** fix this by un-stubbing the scorer: that would break ADR-075 reproducibility (same seed must yield the same winner identity and byte-identical winning `finalScore`). The gate must stay deterministic.

## Decision

Separate the **gate** (reproducible, in the scorer) from the **gradient** (efficiency, in selection), and make the gradient opt-in.

- `EvolutionConfig.tieBreaker?: 'insertion' | 'faster'`, default **`'insertion'`** — the existing, fully reproducible behaviour. Every existing call site and test is unchanged because none sets the field.
- `'faster'`: among the records sharing the **top** `finalScore`, pick the one with the lowest **mean trace wall-clock** (`pickEfficientWinner`, a pure function over the archive records + the per-variant traces already tracked by `tracesById` from ADR-084). A variant with no traces sinks to last (`Infinity`).
- Invariant: the tie-break **never** trades score for speed — a higher-`finalScore` variant always beats a faster lower-score one; only genuine top-score ties are reordered.

`'faster'` is **not reproducible by construction** (wall-clock varies run to run); that is precisely why it is opt-in and why it lives in selection, not in the scored gate.

## Consequences

- Real runs that opt in now converge toward the *most efficient* harness among those that clear the gate — a meaningful, if secondary, fitness signal that the ceiling-bound scorer cannot express.
- Reproducible runs (CI, ADR-075 tests, default usage) are byte-for-byte unchanged.
- This is the minimum, safe step toward graded fitness. The fuller answer — a graded `BenchScore` with non-stubbed cost/latency over a held-out task suite (ADR-076) wired into `evolve --bench` — remains the next milestone; this ADR makes the *default* loop usefully efficiency-aware in the meantime.

## Validation

`packages/darwin-mode` — 293 tests (was 288; +5). `pickEfficientWinner`: null-when-unscored, picks-lowest-ms-among-ties, never-sacrifices-score, no-traces-is-Infinity; plus an order/concurrency check on `mapLimit`. Default-path e2e and reproducibility suites unchanged and green.
