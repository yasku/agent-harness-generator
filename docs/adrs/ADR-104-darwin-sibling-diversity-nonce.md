# ADR-104: Darwin Mode — sibling-diversity nonce (fix one-directional mutation)

**Status**: Accepted (implemented + measured)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-071 (mutation surfaces), ADR-084 (mutation context), ADR-103 (which found this bug)

> ADR-103's instrumentation found that the `DeterministicMutator` never grew the retry budget: `maxAttempts` explored only `{1,2,3}` (≤ baseline). Root cause: all siblings mutating the same surface produced the *same* edit, so a generation explored one direction, not both. This ADR fixes it with a deterministic sibling nonce.

## Context

`DeterministicMutator.generateMutation` chose its edit from `variant = hash(seed, surface, parentCode.length) % 6`. For a fixed parent + surface + seed this is constant, so every child that mutated that surface applied the *identical* edit (e.g. retry budget `3 → 2`). A generation therefore could not contain both `3 → 4` and `3 → 2`; whichever direction the hash picked was the only one explored, and for the live seeds that direction was *down*. Numeric budgets (retry, context window) consequently drifted one way and the retry-gated regions of the task space were unreachable (ADR-103).

## Decision

Add an optional **sibling-diversity nonce** to the `CodeGenerator` contract: the child's index within its generation. `createChildVariant` passes `nonce: index`; `DeterministicMutator` folds it into the edit selection — `variant = hash(seed, surface, parentCode.length, nonce) % 6`. Siblings mutating the same surface now get different `variant` values → different edit directions, so a generation covers both `+` and `−` moves on every numeric rule. It defaults to `0`, so direct callers and the LLM mutator (which ignores it) are unaffected, and it is fully deterministic ⇒ reproducible (ADR-075 preserved).

## Result (measured, 2026-06-18)

Same 8-generation mock run, explored surface-parameter ranges:

| parameter | before (ADR-103) | after |
|---|---|---|
| `maxAttempts` | `[1, 2, 3]` (never grew) | **`[2, 3, 4]`** (grows upward) |
| `contextWindow` | `[30, 50, 70]` | **`[10,15,20,30,40,45,50,60,65]`** (9 values) |

The retry budget now mutates upward, and numeric exploration is far richer in both directions — so retry-gated improvements (not just context-gated, per ADR-103) are now reachable by the search.

## Consequences

- Removes a silent one-directional bias that capped what the loop could discover. The self-improvement demonstrated in ADR-103 (context-gated) now extends to retry-gated landscapes too.
- Pure, deterministic, backward-compatible: 348 tests unchanged (determinism and structural invariants hold; the nonce only diversifies which bounded edit each sibling applies).
- A small fix with outsized effect on search coverage — exactly the kind of issue only an end-to-end run (ADR-103) surfaces.

## Validation

`packages/darwin-mode` — 348 tests green (reproducibility/e2e/mutator suites unchanged: the mutator stays deterministic, just nonce-aware). Before/after exploration ranges measured directly via `extractSurfaceParams` over a full mock run.
