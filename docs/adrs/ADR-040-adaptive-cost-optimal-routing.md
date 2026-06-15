# ADR-040: Adaptive Cost-Optimal Routing — from benchmark to operational router

**Status**: Proposed
**Date**: 2026-06-15
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-037 (DRACO), ADR-038 (quality ceiling), ADR-039 (cost dominance)

---

## Context

The DRACO investigation answered **Phase 1 — "can a harness beat the model?"**
with a bounded, mechanistic *no*: within observed variance, no tested harness arm
exceeded a strong direct call, because grounding is a fraction of resolving URLs
that no transform/select/union strategy can raise (ADR-038).

ADR-039 surfaced the more valuable question. The surprising, measured fact is not
"haiku is cheaper" (everyone knows that) — it is **haiku scored HIGHER than opus
on DRACO while costing ~10× less** (0.7566 vs 0.7143, $0.12 vs $1.22). That is a
claim about *model selection*, and it reframes the goal as **Phase 2 — "can a
harness CHOOSE the right model?"** — the question enterprises actually buy, since
they purchase `quality / dollar`, not `quality`.

> Phase 1: Can a harness beat the model? → No.
> Phase 2: Can a harness choose the right model? → Potentially yes.

## Decision

Build **Adaptive Cost-Optimal Routing** as a measured DRACO mode. Objective:

```
maximize    quality / dollar
subject to  quality >= frontier_baseline − ε
```

i.e. get *frontier-level quality* (or within ε) for the *least money*, by routing
each question to the cheapest model that is good enough for it.

### Benchmark ladder (each measured on the same corpus + scorer)

| config | description | role |
|--------|-------------|------|
| `always_haiku` | cheap model on every question | cheap floor |
| `always_opus` | frontier model on every question | expensive baseline |
| `always_gpt` | a third family on every question | cross-family control |
| `router_v1` | static heuristic (e.g. always cheapest; escalate by domain) | naive router |
| `router_v2` | adaptive: a cheap pre-signal (judge/complexity) decides cheap-vs-escalate per question | real router |
| `oracle_router` | post-hoc picks the per-question best model | **theoretical upper bound** |

The **oracle** is the key construct: for each question it selects, with hindsight,
the model that actually scored highest — the unbeatable routing policy. A real
router's quality is then reported as **% of oracle**. If `router_v2` reaches
**≥95% of oracle quality-per-dollar**, DRACO has become an *operational routing
system*, not just a benchmark.

### Method (cost-aware, no waste)

1. Run vanilla on each pool model per question once → a per-question × per-model
   **score + token matrix** (one live run; reused for every router policy).
2. Compute `always_X` (column means), `oracle` (mean of per-question argmax), and
   any `router_vK` (a pure selection function over the matrix) **offline** from
   that single matrix — no re-running per policy.
3. Score on `quality/dollar` with the ADR-039 price table; report each policy's
   quality, cost, and **% of oracle**.

This needs the **per-question per-model** breakdown (the existing aggregate
artifacts don't carry it), so it adds one routing-matrix capability to the bench;
every router variant after that is free offline arithmetic.

## Consequences

- Converts the honest Phase-1 negative into a Phase-2 product direction:
  MetaHarness as a **cost-optimal model router**, the genuinely valuable business
  problem. Vindicates the ruflo MoE-routing thesis with a measured oracle gap.
- The oracle bounds how much routing can ever help; the router-vs-oracle gap is
  the real, honest figure of merit (not a vanity win vs vanilla).
- Pure-arithmetic policy evaluation over one matrix keeps it offline-testable and
  cheap; CI runs the full suite so the routing result cannot regress.

## Honest guardrails

- The "haiku > opus on DRACO" claim must **survive repeated runs** before it
  earns load-bearing weight — the routing matrix run records per-question scores
  so variance can be quantified, not assumed.
- Scoped to DRACO (grounded factual dossiers). A cost-optimal router here does
  not imply cheap models win on reasoning/code/agentic tasks — the router is
  trained and reported per benchmark, never extrapolated beyond its scope.
