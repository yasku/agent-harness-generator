<!-- SPDX-License-Identifier: MIT -->
# Darwin Mode — end-to-end validation evidence

This suite validates the **whole `evolve` loop** (ADR-070) and the **ADR-075
acceptance properties** against throwaway fixture repos. Each test builds a
self-contained repo in a `node:os` tmpdir (a `package.json` whose `scripts.test`
is a fast, deterministic, dependency-free command — `node -e "process.exit(0)"`,
resolved by the profiler to `npm test` — plus a couple of plain source files),
evolves into a temp `workRoot`, and cleans both up afterwards.

Run it:

```bash
npx vitest run packages/darwin-mode/__tests__/e2e
```

Result: **17 tests, 4 files, all green** (~18 s wall-clock), including a strict
assertion that the winning `finalScore` is byte-reproducible across same-seed
runs (the reproducibility gap noted below has since been fixed in `scorer.ts`).

## Files

| File | What it proves |
|---|---|
| `fixtures/repo.ts` | Builds deterministic throwaway repos + work trees (helpers only). |
| `evolve.e2e.test.ts` | The full loop + the ADR-070 work-tree contract + lineage/tree structure. |
| `safety-invariant.e2e.test.ts` | The "zero unsafe actions" invariant — the most important property. |
| `reproducibility.e2e.test.ts` | ADR-075 reproducibility (and the honest gap in it). |
| `cost-breaker.e2e.test.ts` | The ADR-072 cost circuit-breaker bounds work without crashing. |

## Mapping to ADR-075's acceptance bullets

> **The demo passes when at least one repo shows a reproducible improvement,
> zero unsafe actions, and a clear winning-harness lineage.**

### 1. Zero unsafe actions — PROVEN (strongest evidence here)

`safety-invariant.e2e.test.ts`, after a full 2-generation run:

- **Every produced variant directory** (baseline + every child) returns `[]`
  from `inspectVariant(dir)` — asserted per record, with the offending findings
  inlined into the failure message if any ever appear.
- **Every run trace on disk** (`runs/<id>.json`) has `blockedActions.length === 0`
  and `exitCode !== 99` (the reserved ADR-071 disqualification code). A
  non-vacuous-pass guard asserts traces were actually inspected.
- **Every scorecard** reports `safetyScore === 1.0` and all four hard penalties
  (`secretExposure`, `destructiveAction`, `hallucinatedFile`, `toolLoop`) at `0`.

`reproducibility.e2e.test.ts` re-asserts safety under a *different seed*, and
`cost-breaker.e2e.test.ts` re-asserts it under the breaker — so safety holds
across seeds and under early termination, not just on the happy path.

### 2. Clear winning-harness lineage — PROVEN

`evolve.e2e.test.ts`:

- `result.winnerLineage[0] === result.baseline.variant.id` and the last element
  is the winner — the lineage is rooted at the baseline and ends at the winner.
- The lineage is a **valid parent chain**: every id resolves to a real archive
  record, each step is the `parentId` of the next, and the root is parentless.
- The archive is a **TREE**: every non-baseline variant has a parent that exists
  in the archive *and* lists it as a child (no dangling edges); the only
  parentless node is `baseline` (generation 0).
- `lineage.json` renders a well-formed graph (every edge connects two existing
  nodes; node count equals record count) — i.e. the tree is renderable from the
  archive alone (ADR-073 / ADR-070 Test Contract §4).

### 3. Reproducible winner — PARTIALLY PROVEN (see gap)

`reproducibility.e2e.test.ts` runs `evolve` **twice with the same seed** into two
separate work trees against the same fixture, and asserts:

- identical **winner identity** (`winner.variant.id`),
- identical **winner lineage** (`winnerLineage`),
- identical **archive id ordering** (`records.map(id)`), and
- identical **non-wall-clock score terms** (taskSuccess, testPassRate,
  traceQuality, costEfficiency, safetyScore, all penalties, and the `promoted`
  flag) for every record.

A third run with a **different seed** still completes (winner + full archive) and
stays safe (`inspectVariant === []`, `safetyScore === 1.0`, finite finalScore).

### Work-tree contract (ADR-070) — PROVEN

`evolve.e2e.test.ts` asserts the loop writes `archive.json`, `lineage.json`,
`reports/winner.json`, `runs/baseline.json` + one `runs/<id>.json` per variant,
and a `variants/<id>/` directory per variant. It also checks each run file
carries one trace per task (`['t1','t2']`) plus a matching scorecard, and that
`reports/winner.json` on disk equals `result.winner`.

### Cost circuit-breaker (ADR-072) — PROVEN

`cost-breaker.e2e.test.ts`: with `costBudgetSeconds: 0.0001` the per-generation
commit loop breaks early, yet the run still completes — a winner exists,
`reports/winner.json` and `archive.json` are written, and everything committed
is still safe. A companion test shows a generous budget scores strictly more
records (baseline + all 3 gen-1 children = 4) than the tiny one, proving the
breaker actually bounds work rather than being a no-op.

## Honest limitations — what is NOT yet proven at prototype level

### Reproducibility (FIXED)

ADR-075's bar is "reproduce the winning **score** from a clean checkout". This is
now met: the winning `finalScore` **is** byte-reproducible across same-seed runs,
asserted strictly by `reproducibility.e2e.test.ts`.

- **Former root cause.** `src/scorer.ts` derived `latencyEfficiency` from
  **wall-clock** `durationMs`, which is not reproducible, so `finalScore` drifted
  by a timing-dependent epsilon (observed Δ ≈ 4e-7) — and under parallel load the
  drift was even enough to flip the winner's identity among the prototype's ties.
- **Fix.** At prototype level every variant runs the *identical* test command, so
  per-variant wall-clock is pure noise. `scorer.ts` now scores latency (and cost)
  as **deterministic prototype hooks** (`1.0`) and rounds every score field to 6
  decimals, making the scorer a pure function of deterministic inputs. Raw
  `durationMs` is still recorded per trace for observability. The real
  latency/cost formula (ADR-072) returns with the LLM-backed evaluator, where
  variants differ structurally rather than by jitter.
- **Pinned.** `reproducibility.e2e.test.ts` now asserts strict `finalScore` and
  `baseScore` equality across two same-seed runs (converted from the old
  `it.fails` tripwire), alongside winner-identity and lineage reproducibility.

### No real task-success differentiation (deterministic mutator → ties)

The prototype's `DeterministicMutator` makes bounded, capability-neutral edits
to one surface file, but the sandbox scores variants by running the repo's
`npm test`, which is **identical** for every variant (the child cannot edit the
benchmark). So every variant passes the same tests with the same `taskSuccess`,
and **no child beats the baseline by `promotionDelta`** — the promotion gate
never fires, ties break to the earliest insertion, and the **baseline itself is
the "winner"** on these fixtures. This is expected and correct for the
deterministic prototype.

Real task-success differentiation (and thus a *promoted, improved* winner, the
"≥15% improvement" 30-day claim, and ADR-075 Test Contract §1/§5) requires the
**LLM-backed `CodeGenerator`** slotted in behind the same `validateGeneratedCode`
gate (ADR-071 §contract) plus task harnesses that actually exercise the mutated
surfaces. That is out of scope for this prototype validation; the loop, the
gate, the archive, and the lineage — the parts that must be right before any of
that matters — are proven here.

### Other scope notes

- The sandbox effectively runs `npm test` (the profiler resolves the test
  command to `<pm> test`), so these tests require a working `npm`/`node`
  toolchain on PATH. The fixture script is quoted (`node -e "process.exit(0)"`)
  so npm's shell invocation exits 0 deterministically.
- `costEfficiency` and `costOverrun` are fixed proxies in the prototype scorer
  (1.0 / 0); the cost-breaker is validated via the per-generation
  variant-seconds proxy, not a real cost meter.
