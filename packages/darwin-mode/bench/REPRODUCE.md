# Reproduce every Darwin Mode result

Every claim in ADR-084…116 is backed by a committed experiment + result artifact.
This is the index: run the command, compare to `bench/results/<file>`. Build first:

```bash
npm run build        # tsc → dist/ (Tier-2 / agent experiments import dist/)
```

Conventions: **det** = deterministic & reproducible (same output every run, no
network). **agent** = runs child `node --experimental-strip-types` (Node ≥ 22, no
LLM, deterministic). **LLM** = one or more live OpenRouter calls (set
`OPENROUTER_API_KEY`); costs are pennies and are *not* bit-reproducible.

| # | Experiment | Command | Result file | Finding | Type |
|---|---|---|---|---|---|
| 085 | Polyglot model frontier | `node bench/polyglot/run-cell.mjs <model> <lang>` (+ swarm) | `results/polyglot-code-frontier.json` | DeepSeek-V3 tops quality/$ across 6 langs | LLM |
| 087 | evolve mutator parity | `node /tmp/darwin-bench.mjs <repo> <model>` | `results/evolve-mutator-parity.json` | det vs LLM mutator both hit 0.985 ceiling | LLM |
| 095 | Poincaré vs Euclidean niches | `node bench/ablation/poincare-vs-euclidean.mjs` | `results/poincare-vs-euclidean-ablation.json` | Poincaré better only on depth-structured data | det |
| 099 | System audit dashboard | `node bench/system-audit.mjs` | `results/system-audit.json` | determinism 0; FDR 0.049≤0.05; nicheEntropy 0 (real) | det |
| 102 | Manifold goes live | (inline, see ADR-102) | `results/manifold-live.json` | mock: entropy 0→0.69, scores flat→0.43–0.80 | agent |
| 103 | Self-improvement | (inline, see ADR-103) | `results/self-improvement-demo.json` | window 30→70, finalScore 0.765→0.985 | agent |
| 105 | Diversity beats greedy (mock) | (inline, see ADR-105) | `results/deception-experiment.json` | greedy 0/5, behavioral-diversity 5/5 | det/mock |
| 107 | Real-LLM eval PoC | `node bench/experiments/real-llm-eval-poc.mjs` | `results/real-llm-eval-poc.json` | real test FAIL→PASS via 1 call, $0.0005 | LLM |
| 109 | Surface gates real LLM | `node --experimental-strip-types bench/experiments/real-surface-llm-eval.mjs` | `results/real-surface-llm-eval.json` | wide window lets LLM fix; narrow can't | LLM |
| 110 | Evolution lifts real-LLM pass-rate | `node --experimental-strip-types bench/experiments/real-llm-evolution.mjs` | `results/real-llm-evolution.json` | 1/3→3/3, window 30→70, 1 cached call | LLM |
| 111 | Falsify: window not ranking | `node --experimental-strip-types bench/experiments/falsify-context-selection.mjs` | `results/falsify-context-selection.json` | first-N == real ctxb (flat distractors) | agent |
| 112 | FDR calibration at small n | `node bench/experiments/fdr-calibration.mjs` | `results/fdr-calibration.json` | BH fails at n=3 (0.33), OK at n≥5 | det |
| 113 | Ranking IS causal (varied relevance) | `node --experimental-strip-types bench/experiments/ranking-matters.mjs` | `results/ranking-matters.json` | real ctxb solves where first-N can't | agent |
| 114 | Diversity advantage substrate-dependent | `node --experimental-strip-types bench/experiments/real-substrate-deception.mjs` | `results/real-substrate-deception.json` | agent: greedy 3/3, diversity 2/3 (not replicated) | agent |
| 115 | Crossover ablation | `node --experimental-strip-types bench/experiments/crossover-ablation.mjs` | `results/crossover-ablation.json` | crossover-off crosses 2/2 → archive does the work | agent |
| 116 | Retention ablation | `node --experimental-strip-types bench/experiments/retention-ablation.mjs` | `results/retention-ablation.json` | retention helps (2/2 vs 1/2); inconclusive at n=2 | agent |
| 117 | Real multi-file SWE nucleus | `node --experimental-strip-types bench/experiments/swe-nucleus.mjs` | `results/swe-nucleus.json` | real ctxb selects → real LLM reasons over real code → real test FIXED | LLM |
| 118 | SWE suite generalizes | `node --experimental-strip-types bench/experiments/swe-suite.mjs` | `results/swe-suite.json` | 5/5 varied real bugs fixed, correct file chosen each, $0.001 | LLM |
| 119 | Multi-domain evolution | `node --experimental-strip-types bench/experiments/swe-evolution.mjs` | `results/swe-evolution.json` | evolution lifts real-test pass-rate 0/5→5/5 (window 30→50), 5 cached calls | LLM |

DRACO (`results/draco-quality-cost-frontier.json`, ADR-037–040 lineage) and the
human-readable summary (`results/RESULTS.md`) accompany these.

Honest notes: `LLM` rows are not bit-reproducible (model nondeterminism) and the
corrected/tempered claims are 111 (window not ranking), 112 (FDR n≥5), 114
(diversity not universal), 115 (crossover not load-bearing). The full self-correcting
narrative is ADR-108 (synthesis) → ADR-111…116.
