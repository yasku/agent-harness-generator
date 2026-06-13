// SPDX-License-Identifier: MIT
//
// 3-tier routing decision per ADR-026 (ruflo) + ADR-002 (this repo).
//
// Tier 1 (Codemod):  deterministic transform, no LLM. <1ms, $0.
//                    Use for: structural edits like var->const, remove-
//                    console, add-logging.
// Tier 2 (Small):    Haiku-class. ~500ms, ~$0.0002/call.
//                    Use for: simple completions, naming, doc edits.
// Tier 3 (Frontier): Sonnet/Opus-class. 2-5s, $0.003-$0.015/call.
//                    Use for: architecture, security, multi-step reasoning.
//
// The kernel owns the DECISION; the host adapter maps each tier to the
// concrete model id available on that host. This decouples model availability
// from routing logic.

//! 3-tier routing decision with real heuristics.

use serde::{Deserialize, Serialize};

/// Routing tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    /// Deterministic codemod / inline.
    Codemod,
    /// Small model (Haiku-class).
    Small,
    /// Frontier model (Sonnet/Opus-class).
    Frontier,
}

/// Inputs the router uses to decide a tier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingInput {
    /// The task description (what the user asked for).
    pub prompt: String,
    /// Approximate token count of the prompt (so callers don't have to
    /// re-tokenise; if 0, the router estimates).
    #[serde(default)]
    pub prompt_tokens: u32,
    /// Whether tool use will be required (e.g. file edits).
    #[serde(default)]
    pub needs_tools: bool,
    /// Optional explicit hint from the caller.
    #[serde(default)]
    pub force_tier: Option<Tier>,
}

/// Routing decision for a single task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingDecision {
    /// Chosen tier.
    pub tier: Tier,
    /// One-line rationale (for telemetry / replay).
    pub rationale: String,
    /// Estimated tokens the router thought this prompt was.
    pub estimated_tokens: u32,
}

/// Keyword sets that bump a task toward Frontier or pin it to Codemod.
const CODEMOD_KEYWORDS: &[&str] = &[
    "var to const",
    "var-to-const",
    "remove console",
    "remove-console",
    "add logging",
    "add-logging",
    "rename to",
    "kebab case",
    "snake case",
    "format code",
    "prettier",
    "lint fix",
];

const FRONTIER_KEYWORDS: &[&str] = &[
    "architecture",
    "design",
    "security",
    "audit",
    "threat model",
    "review the entire",
    "refactor across",
    "migration plan",
    "data model",
    "schema design",
    "trade-off",
    "evaluate options",
    "compare approaches",
    "incident",
    "regression",
    "race condition",
    "deadlock",
    "memory leak",
    "cve",
];

/// Heuristic token estimate when the caller didn't supply one.
/// 4 chars per token is the commonly-cited approximation for English text.
fn estimate_tokens(prompt: &str) -> u32 {
    (prompt.chars().count() / 4).max(1) as u32
}

/// Make a routing decision for a single task.
///
/// Algorithm (priority order):
///   0. If `force_tier` is set, honor it.
///   1. If any CODEMOD keyword matches, route to Codemod (saves the LLM
///      call entirely).
///   2. If any FRONTIER keyword matches, route to Frontier.
///   3. If estimated_tokens > 4000, route to Frontier (long-context bias).
///   4. If `needs_tools`, route to Small at minimum (Codemod can't do tool
///      use), otherwise Small for short prompts, Frontier for long.
///   5. Default: Small.
pub fn decide(input: &RoutingInput) -> RoutingDecision {
    let tokens = if input.prompt_tokens > 0 {
        input.prompt_tokens
    } else {
        estimate_tokens(&input.prompt)
    };

    if let Some(t) = input.force_tier {
        return RoutingDecision {
            tier: t,
            rationale: "force_tier".into(),
            estimated_tokens: tokens,
        };
    }

    let lower = input.prompt.to_ascii_lowercase();

    if let Some(kw) = CODEMOD_KEYWORDS.iter().find(|k| lower.contains(*k)) {
        return RoutingDecision {
            tier: Tier::Codemod,
            rationale: format!("codemod keyword: {kw}"),
            estimated_tokens: tokens,
        };
    }

    if let Some(kw) = FRONTIER_KEYWORDS.iter().find(|k| lower.contains(*k)) {
        return RoutingDecision {
            tier: Tier::Frontier,
            rationale: format!("frontier keyword: {kw}"),
            estimated_tokens: tokens,
        };
    }

    if tokens > 4000 {
        return RoutingDecision {
            tier: Tier::Frontier,
            rationale: format!("long context: {tokens} tokens"),
            estimated_tokens: tokens,
        };
    }

    if input.needs_tools {
        return RoutingDecision {
            tier: Tier::Small,
            rationale: "needs tools, no frontier signal".into(),
            estimated_tokens: tokens,
        };
    }

    RoutingDecision {
        tier: Tier::Small,
        rationale: "default".into(),
        estimated_tokens: tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(prompt: &str) -> RoutingInput {
        RoutingInput {
            prompt: prompt.into(),
            prompt_tokens: 0,
            needs_tools: false,
            force_tier: None,
        }
    }

    #[test]
    fn decision_round_trips() {
        let d = RoutingDecision {
            tier: Tier::Small,
            rationale: "trivial".into(),
            estimated_tokens: 42,
        };
        let s = serde_json::to_string(&d).unwrap();
        let back: RoutingDecision = serde_json::from_str(&s).unwrap();
        assert_eq!(back.tier, Tier::Small);
    }

    #[test]
    fn codemod_keyword_routes_codemod() {
        let d = decide(&input("Please remove console statements from src/"));
        assert_eq!(d.tier, Tier::Codemod);
        assert!(d.rationale.contains("remove console"));
    }

    #[test]
    fn frontier_keyword_routes_frontier() {
        let d = decide(&input("Review the architecture of this module"));
        assert_eq!(d.tier, Tier::Frontier);
        assert!(d.rationale.contains("architecture"));
    }

    #[test]
    fn long_context_routes_frontier() {
        let d = decide(&input(&"x".repeat(20_000)));
        assert_eq!(d.tier, Tier::Frontier);
        assert!(d.rationale.contains("long context"));
    }

    #[test]
    fn default_short_prompt_routes_small() {
        let d = decide(&input("Add a doc comment to this function"));
        assert_eq!(d.tier, Tier::Small);
    }

    #[test]
    fn force_tier_wins() {
        let mut i = input("Please remove console statements");
        i.force_tier = Some(Tier::Frontier);
        let d = decide(&i);
        assert_eq!(d.tier, Tier::Frontier);
        assert_eq!(d.rationale, "force_tier");
    }

    #[test]
    fn needs_tools_caps_at_small_when_short() {
        let mut i = input("Apply that change");
        i.needs_tools = true;
        let d = decide(&i);
        assert_eq!(d.tier, Tier::Small);
    }

    #[test]
    fn codemod_beats_frontier_when_both_match() {
        // Priority order: codemod first, even if frontier keyword present.
        let d = decide(&input("Remove console statements for security audit"));
        assert_eq!(d.tier, Tier::Codemod);
    }

    #[test]
    fn explicit_token_count_overrides_estimate() {
        let mut i = input("short prompt");
        i.prompt_tokens = 8000;
        let d = decide(&i);
        assert_eq!(d.tier, Tier::Frontier);
    }
}
