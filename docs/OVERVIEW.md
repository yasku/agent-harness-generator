# agent-harness-generator

> A CLI that scaffolds custom AI agent harnesses — the way `create-vite` scaffolds web apps, but for vertical agent systems.

**Status**: v0.1.x beta. The repo `ruvnet/agent-harness-generator` is published — `metaharness` on npm plus the `@metaharness/*` kernel, host adapters, and example packages. This directory holds the Architecture Decision Records (ADRs) that define what the system is, how it is structured, what it ships, and which trade-offs were taken; the implementation tracks them.

**Read in order**: [adrs/INDEX.md](./adrs/INDEX.md).

---

## What is this in one paragraph

Ruflo today is a tightly-bundled product: a kernel of primitives (MCP server, hooks runner, memory bridge, swarm coordinator, intelligence pipeline, claims, 3-tier routing) fused to opinionated content (60+ agents, 30+ skills, 33 plugins). `agent-harness-generator` factors that apart. A user runs `npx create-agent-harness <name>`, picks the primitives they want, picks the content they want, supplies a name and a brand, and gets a brand-new npm-publishable harness with its own `npx <their-name>` CLI, its own MCP server registration, its own memory namespace, its own marketplace identity. The generator handles trivial scaffolds (a 3-agent customer-support harness) and exotic compositions (federated multi-host swarms with a vertical-specific intelligence pipeline) from the same machinery.

## Why this exists

Three forces are pushing toward this:

1. **Ruflo is converging.** People want their own brand, their own agents, their own skill packs, their own marketplace listings. Forking ruflo to get them is a one-way door — they lose every future kernel update.
2. **The hosts have multiplied.** Claude Code is no longer the only place users want their harness to run. OpenAI Codex CLI has MCP support, the Hermes-agent / Nous Research stack has its own conventions, and the pi.dev developer platform is emerging. A scaffolded harness should target any host without rewrite.
3. **The marketplace is heating up.** A scaffolded harness is also a marketplace participant — it both consumes plugins from the ruflo IPFS registry and (optionally) publishes its own scoped plugins back. Without a generator, every new participant rebuilds 80% of the same infrastructure by hand.

## What is in this directory

| Path | Purpose |
|---|---|
| `README.md` | (you are here) 3-minute orientation |
| `adrs/INDEX.md` | Read-in-order index for the ADR series |
| `adrs/ADR-001-…` through `adrs/ADR-016-…` (plus `ADR-002a-…`) | The decisions, each independently reviewable |

No code lives here. No code should live here. This directory is the contract that the eventual repo `ruvnet/agent-harness-generator` will be built against.

## Three minute reading path

If you have three minutes:

- Read **ADR-001** (Goals and non-goals) — what we are and are not building.
- Skim **ADR-002** (Kernel boundary) — the single load-bearing decision.
- Skim **ADR-003** (Generator architecture) — how the CLI works end-to-end.

If you have fifteen minutes, read those three plus **ADR-004** (host integration), **ADR-007** (CI guards), and **ADR-009** (anti-slop). That set defines the system perimeter.

The rest of the series fills in: memory integration, drift detection, witness/provenance, eject/upgrade, vertical packs, self-evolution + federation, naming/branding, and migration for existing ruflo users.

## Conventions

- ADRs are numbered `ADR-NNN-kebab-case-slug.md`, three-digit padding.
- Each ADR follows the standard ruflo template (`Title / Status / Context / Decision / Consequences / Alternatives / Test Contract / References`).
- "We" in the ADRs means the agent-harness-generator project, not the ruflo monorepo. Where a decision binds back to a ruflo ADR, the ruflo ADR is cited by number.
- Plain language is the rule. Terms of art are defined inline at first use.

## Out of scope for this ADR set

These are explicitly **not** decided here, and have been deferred:

- A hosted web UI ("generator-as-a-service"). May appear in a later phase; see ADR-001 §Non-goals.
- A non-npm distribution channel for generated harnesses (e.g. PyPI for Python harnesses). Future work.
- A formal certification programme for marketplace plugins. ADR-009 specifies a reputation-and-signal model, not a certification body.

## Who should read this

- **Implementers.** If you are about to write `packages/create-agent-harness`, read ADR-001 → ADR-003 → ADR-010 (TDD contract) first.
- **Reviewers.** If you are reviewing a PR against this repo, the ADR it amends or supersedes should be in the PR description.
- **Adopters.** If you want to ship your own harness, you do not need to read these. Wait for the `create-agent-harness` CLI to exist; read its user docs then.
