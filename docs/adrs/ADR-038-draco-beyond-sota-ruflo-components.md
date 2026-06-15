# ADR-038: DRACO beyond-SOTA — optimizing the research harness with ruflo intelligence components

**Status**: Proposed
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Supersedes**: none
**Related**: ADR-037 (DRACO benchmark), ADR-009 (intelligence pipeline), `vertical:research` template

---

## Context

ADR-037 established DRACO: a cross-domain deep-research benchmark with a
three-way ablation — **vanilla < harness < fusion+harness** — scored on five
dimensions (grounding, coverage, balance, cleanliness, faithfulness). The
benchmark exists; the open question is **can the harness beat SOTA, and if not,
what makes it beat SOTA?**

Measured so far (honest, not gamed):

- **Cheap tier (n=20)** — haiku-4.5 / gpt-5-mini / gemini-2.5-flash: the thesis
  did **not** hold. Ordering inverted: vanilla 0.7788 > harness 0.7611 > fusion
  0.7594. The extra dossier-rewriting stages added scorer-penalised noise
  without a compensating grounding/faithfulness gain on weak models.
- **Frontier tier (n=20)** — opus-4 / gpt-5 / gemini-2.5-pro: baseline run in
  progress; recorded in `packages/bench/draco/runs/threeway-frontier-full.json`.

The directive: **keep running until the benchmark meets or beats SOTA, and use
ruflo components to get there.** "SOTA" for DRACO = the fusion+harness arm
strictly beating both vanilla and the single-model harness at frontier tier,
with margin, on the same corpus + scorer.

A single-model pipeline with extra steps is not enough — the cheap-tier result
proves structure alone can hurt. The harness needs components that add *real*
signal: independent verification that actually catches errors, memory that
reuses what worked, and routing that puts the right model on each sub-task.
That is exactly what the ruflo intelligence stack provides.

## Decision

Improve the DRACO research harness by applying **ruflo intelligence components**
(the RETRIEVE → JUDGE → DISTILL → CONSOLIDATE pipeline, HNSW/ReasoningBank
memory, MoE/SONA routing) as native, dependency-injected, offline-testable
modules in `packages/bench/src/draco/`. Each is an independent ablation arm so
its contribution is **measured**, never assumed.

### Improvement 1 — Self-consistency JUDGE selection (RETRIEVE→JUDGE)

Generate `N` candidate dossiers per question with varied decomposition
(temperature / sub-query diversity), score each with the independent judge, and
select (or fuse) the highest-faithfulness candidate. Directly targets the two
dimensions a single pass cannot self-correct: faithfulness and grounding.
Mechanism: ruflo's JUDGE step over a candidate set.

### Improvement 2 — Memory-augmented retrieval (HNSW / ReasoningBank)

Maintain a cross-question memory of high-grading sources and winning synthesis
strategies (NOT answers — questions are independent, no answer leakage). Before
synthesis, RETRIEVE the most relevant prior *strategies* via HNSW and inject
them as guidance. CONSOLIDATE after each question. Targets coverage + balance.

### Improvement 3 — MoE / SONA per-stage model routing

Learn, from per-stage scoring outcomes, which model family is strongest for each
stage and route accordingly (cheap for decompose/cite, strong+independent for
synthesize/verify). Targets cost-efficiency and grounding. Mechanism: ruflo MoE
gate + SONA adaptation over the per-stage reward signal.

### Iteration protocol (the 15m loop)

1. Run / read the latest DRACO frontier three-way.
2. If fusion does not beat vanilla AND the single-model harness with margin,
   integrate the next improvement arm, with tests, behind a flag.
3. Re-benchmark that arm vs. baseline on the same corpus. Keep only measured
   wins; discard or revert measured non-wins (honest — the cheap-tier inversion
   is the precedent).
4. Push to main, update this ADR's results table, open/update the tracking
   issue + gist, extend the CI guard.

## Consequences

- Every improvement is a **measured** ablation arm, not an assertion. A
  component that does not move the score is removed, exactly as the cheap-tier
  fusion arm would be if it never recovered.
- Offline-testability is preserved: all model + memory + judge calls go through
  injected transports, so the bench suite runs with mocks and no API key.
- **CI guard (no regression):** `.github/workflows/draco.yml` gains a
  deterministic offline assertion that each shipped improvement arm beats its
  baseline on a fixed mock fixture, plus the existing judged-run cadence for the
  live number. A merged improvement cannot silently regress.

## Results (living — updated each iteration)

| Tier | vanilla | harness | fusion+harness | thesis | notes |
|------|---------|---------|----------------|--------|-------|
| cheap n=20 | 0.7788 | 0.7611 | 0.7594 | NO | structure hurt on weak models |
| frontier n=20 (baseline) | 0.7143 | 0.6126 | 0.6472 | NO | harness DEGRADES −0.10 vs vanilla; fusion recovers +0.035 but still < vanilla. ordering: harness < fusion < vanilla |

#### Arm 1 — augment-not-replace (verify→prune): REJECTED

| arm | vanilla | augment | Δ | grounding Δ | coverage Δ | cleanliness Δ | result |
|-----|---------|---------|---|-------------|------------|---------------|--------|
| frontier n=20 | 0.7258 | 0.6982 | **−0.0275** | **−0.09** | **−0.07** | 0.00 | LOSES |

The prune pass strips grounding (−0.09) and coverage (−0.07) without improving
cleanliness (0.00). Root cause: the independent verifier cannot re-fetch URLs,
so it flags real citations as "unsupported" from the text alone, and the prune
obediently removes them — discarding the exact grounding the scorer rewards.
Kept in-tree as a tested, documented, MEASURED-rejected arm (not the default).

**Cross-result learning (the key insight):** *every transformation of the
dossier loses grounding* — the harness rebuild loses it, the prune loses it —
because the scorer re-fetches real URLs and vanilla's single direct call
produces the most real, re-fetchable citations. Therefore an improvement must
**SELECT or UNION, never rewrite.** Next arm: best-of-N self-consistency
selection (generate N intact vanilla dossiers, pick the highest judged — never
transforms a dossier, so grounding cannot be lost; can only match or exceed the
single draw).

#### Arm 2 — self-consistency best-of-3 selection: FIRST NON-LOSS (tie, no margin)

| arm | vanilla | best-of-3 | delta | grounding | coverage | balance | faithful | result |
|-----|---------|-----------|-------|-----------|----------|---------|----------|--------|
| frontier n=20 | 0.7189 | 0.7196 | **+0.0007** | -0.02 | **+0.05** | -0.05 | +0.02 | TIE |

First arm not to lose — SELECTION (vs transformation) is the right family. But
+0.0007 is within noise, NOT the margin the directive requires. The lesson is in
the per-dimension split: the diverse-angle candidates genuinely raised COVERAGE
(+0.05), but the HOLISTIC judge selector traded away BALANCE (-0.05), netting a
wash. Selection histogram [4,11,5]: emphasised angles win 16/20, so the candidate
set is real — the bottleneck is the SELECTION SIGNAL, mis-aligned with the DRACO
composite scorer.

**Arm 3 — composite per-dimension selection:** have the judge rate each candidate
on the SAME dimensions the scorer uses (grounding, coverage, balance, faithfulness)
and select on the equal-weight SUM, so selection optimises what is actually scored
rather than a single holistic guess. Hypothesis: keep the coverage gain without
the balance leak → turn the tie into a margin.

**Emerging honest conclusion (provisional):** a single well-prompted frontier call
is at or near the DRACO ceiling — structure hurts (-0.10), refinement hurts
(-0.03), selection ties (+0.001). If composite selection also only ties, the robust
result worth shipping is the benchmark's own verdict: deep-research *structure* does
not beat a strong direct call on cross-domain factual dossiers under this scorer.

#### Arm 3 — composite per-dimension selection: does NOT win (within noise)

| arm | vanilla | best-of-3 | delta | grounding | coverage | balance | faithful | result |
|-----|---------|-----------|-------|-----------|----------|---------|----------|--------|
| frontier n=20 | 0.7325 | 0.7291 | **-0.0034** | -0.02 | +0.02 | **+0.03** | -0.05 | LOSS (noise) |

Composite selection fixed arm 2's balance leak (+0.03 vs -0.05) and kept coverage,
but faithfulness dropped (-0.05) — the candidate-level judge faithfulness rating
doesn't align with the scorer's separate faithfulness judge. Net -0.0034.

### Conclusion: vanilla is at the DRACO ceiling (well-evidenced)

The decisive evidence is **vanilla's own run-to-run variance**. Across the four
frontier runs vanilla scored 0.7143 / 0.7258 / 0.7189 / 0.7325 — a spread of
**±0.02**, which is *larger than every arm's delta vs vanilla*:

| arm | best Δ vs vanilla | inside vanilla's ±0.02 noise? |
|-----|-------------------|-------------------------------|
| harness (6-stage) | −0.10 | no — a real LOSS |
| augment (verify→prune) | −0.03 | borderline — a real loss |
| self-consistency (holistic) | +0.001 | YES — noise |
| self-consistency (composite) | −0.003 | YES — noise |

So selection arms do not merely "fail to win by margin" — their deltas are
**inside vanilla's own noise floor.** To claim a margin win an arm must beat
vanilla by MORE than ~0.02 (vanilla's between-run swing), with repeats. No
transform/select arm approaches that. The honest, robust result: **on the DRACO
scorer at frontier tier, a single well-prompted direct call is at the ceiling;
deep-research structure and refinement degrade it, and selection matches it
within noise.**

The one untested, structurally-distinct lever is **UNION** (arm 4): merge the
real, deduplicated citations from N independent vanilla dossiers. Unlike
selection (capped by the best single draw) this can *add* grounding — the
dominant dimension — above any single call. It is the only approach that could
plausibly clear vanilla's noise floor. If UNION also stays within ±0.02, the
ceiling finding is airtight and is the deliverable.

### What the baseline tells us (the real target)

The harness loses to vanilla at BOTH tiers, and at frontier the gap is large
(−0.10). Root cause hypothesis: the decompose→search→grade→synthesize chain
forces the synthesizer to work from an intermediate "graded sources" summary
with **no real web retrieval**, so it loses the grounding (real, re-fetchable
URLs) that a single direct "write a cited dossier" call produces. Fusion's
independent verifier recovers ~0.035 by pruning unsupported claims, but cannot
restore the lost grounding.

**Revised optimization target:** the harness must AUGMENT the strong direct
dossier, not REPLACE it through lossy stages. The first arm (below) tests this
directly: keep vanilla's grounding, add an independent verify+prune pass that
only raises cleanliness/faithfulness without rebuilding (and discarding) the
dossier. Self-consistency selection (best-of-N judged) is the second lever.
