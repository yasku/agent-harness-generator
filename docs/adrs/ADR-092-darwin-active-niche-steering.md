# ADR-092: Darwin Mode — active niche steering (navigating the Poincaré manifold)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-091 (hyperbolic behavioral phenotyping), ADR-088 (MAP-Elites), ADR-073 (archive selection)

> ADR-091 gave each variant a coordinate in the Poincaré ball and bins for diversity. Diversity selection *maintains* spread; this ADR *drives* it — actively seeding the next generation from survivors nearest an under-explored region, preferring the high-complexity boundary. Evolution stops being passive and starts navigating the behavioural manifold.

## Context

With behavioural phenotyping (ADR-091) the archive is a topological map of agent capability: origin = shallow stable executors, boundary = deep recursive strugglers, angle = behavioural mode. `behavioral-diversity` selection keeps one elite per occupied niche — but it cannot *reach toward* niches that are empty. Open-endedness wants the opposite of convergence: detect where the map is blank (especially the complex, high-radius frontier) and push there.

Because we have a true metric — the Poincaré distance `d_𝔹(u,v)` — "push toward an empty region" is concrete: pick the hole, then select the survivors closest to it; their mutations are the most likely to land inside.

## Decision

Add closed-form steering primitives to `phenotype.ts`:

- `nicheCentroid(shell, sector)` — the geometric centre of a niche cell in the disk.
- `underExploredTarget(occupied, shells, sectors)` — scan shells **outside-in** (prefer the high-radius complexity frontier) and return the first unoccupied cell's id + centroid; `null` when the manifold is full.
- `nearestToTarget(candidates, target, limit)` — rank candidates by Poincaré distance to the target (ascending) and return the nearest `limit` ids.
- `embedTraces(traces)` — the variant's Poincaré point.

Wire into `evolve()` via `selection: 'niche-steering'`: each stalled generation computes the occupied niche set from the scored archive, finds the outermost hole, and seeds parents from the survivors nearest it (`steerTowardHole`). If the manifold is full or no candidate exists, it degrades gracefully to `behavioral-diversity` elites. CLI: `--selection niche-steering`. Deterministic throughout.

## Consequences

- The population is actively pulled toward unrepresented behaviours — the difference between "don't lose diversity" and "go manufacture the diversity we lack". Concretely, a sparsely-populated complex-behaviour frontier gets seeded from the variants already closest to it.
- All steering is closed-form and deterministic → reproducible, composes with the existing selection modes, and adds no dependency.
- Natural next steps (queued): treat niches as nodes in a RuVector GNN to learn epistatic surface linkages (topology-aware crossover), and a Pareto complexity-vs-cost selector per niche. Steering supplies the target; the GNN will supply *which surfaces to recombine* to reach it.

## Validation

`packages/darwin-mode` — 315 tests (was 311; +4): `nicheCentroid` back-maps into the shell it names, `underExploredTarget` prefers the outermost hole and returns `null` when full, and `nearestToTarget` ranks by Poincaré distance. Default/diversity/reproducibility paths unchanged and green; CLI `--selection niche-steering` smoke-runs.
