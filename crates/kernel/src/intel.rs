// SPDX-License-Identifier: MIT
//
// Intelligence pipeline: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE.
//
// Per ADR-006, the four-phase pipeline turns successful trajectories into
// distilled patterns the next call can reuse. Each phase is a kernel
// primitive callable from the wasm/napi surface; the host owns the actual
// LLM-as-judge calls and storage. The kernel owns the orchestration: which
// phase runs next, when to gate, when to fire DISTILL.

//! Intelligence pipeline phases + orchestration.

use serde::{Deserialize, Serialize};

/// One phase of the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    /// Retrieve k=1 candidate (per ReasoningBank: more memory hurts).
    Retrieve,
    /// LLM-as-judge.
    Judge,
    /// Extract strategies.
    Distill,
    /// EWC++-style consolidation.
    Consolidate,
}

/// Outcome of a single phase.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum PhaseOutcome {
    /// Phase succeeded; carry forward to next phase.
    Success {
        /// Free-form output the next phase consumes.
        output: serde_json::Value,
    },
    /// Phase chose to skip; pass through unchanged.
    Skip { reason: String },
    /// Phase failed; pipeline stops here.
    Fail { reason: String },
}

/// A single trajectory step (input + outcome).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrajectoryStep {
    /// Phase this step is in.
    pub phase: Phase,
    /// Outcome of running this phase.
    pub outcome: PhaseOutcome,
    /// Unix-second timestamp.
    pub timestamp: i64,
}

/// State the pipeline carries across phases.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PipelineState {
    /// Steps recorded so far.
    pub steps: Vec<TrajectoryStep>,
    /// True if the pipeline has reached CONSOLIDATE successfully.
    pub completed: bool,
    /// True if a Fail outcome was recorded.
    pub aborted: bool,
}

impl PipelineState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_phase(&self) -> Option<Phase> {
        self.steps.last().map(|s| s.phase)
    }

    pub fn record(&mut self, step: TrajectoryStep) {
        if matches!(step.outcome, PhaseOutcome::Fail { .. }) {
            self.aborted = true;
        }
        if step.phase == Phase::Consolidate && matches!(step.outcome, PhaseOutcome::Success { .. })
        {
            self.completed = true;
        }
        self.steps.push(step);
    }
}

/// Decide which phase runs next given the pipeline's current state.
///
/// Default order: Retrieve -> Judge -> Distill -> Consolidate.
/// Skipped or successful phases advance; failed pipelines do not advance.
pub fn next_phase(state: &PipelineState) -> Option<Phase> {
    if state.aborted || state.completed {
        return None;
    }
    let last = state.last_phase();
    Some(match last {
        None => Phase::Retrieve,
        Some(Phase::Retrieve) => Phase::Judge,
        Some(Phase::Judge) => Phase::Distill,
        Some(Phase::Distill) => Phase::Consolidate,
        Some(Phase::Consolidate) => return None,
    })
}

/// Decide whether DISTILL should fire on the most recent JUDGE outcome.
///
/// Per ADR-006, DISTILL is gated by a change-point detector. The kernel
/// exposes the gating predicate; the actual detector lives in the TS
/// memory subsystem (`distillTrigger()` over PageHinkleyDetector).
///
/// This kernel-side predicate is the fallback when the TS detector isn't
/// available: fire if the JUDGE returned Success with `judge_score >= 0.7`.
pub fn should_fire_distill(judge_output: &serde_json::Value) -> bool {
    judge_output
        .get("judge_score")
        .and_then(|v| v.as_f64())
        .map(|s| s >= 0.7)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(phase: Phase, outcome: PhaseOutcome) -> TrajectoryStep {
        TrajectoryStep {
            phase,
            outcome,
            timestamp: 0,
        }
    }

    #[test]
    fn phase_serializes() {
        assert_eq!(
            serde_json::to_string(&Phase::Distill).unwrap(),
            "\"Distill\""
        );
    }

    #[test]
    fn empty_pipeline_starts_with_retrieve() {
        let s = PipelineState::new();
        assert_eq!(next_phase(&s), Some(Phase::Retrieve));
    }

    #[test]
    fn pipeline_advances_through_phases() {
        let mut s = PipelineState::new();
        s.record(step(
            Phase::Retrieve,
            PhaseOutcome::Success {
                output: serde_json::json!(null),
            },
        ));
        assert_eq!(next_phase(&s), Some(Phase::Judge));
        s.record(step(
            Phase::Judge,
            PhaseOutcome::Success {
                output: serde_json::json!(null),
            },
        ));
        assert_eq!(next_phase(&s), Some(Phase::Distill));
        s.record(step(
            Phase::Distill,
            PhaseOutcome::Success {
                output: serde_json::json!(null),
            },
        ));
        assert_eq!(next_phase(&s), Some(Phase::Consolidate));
        s.record(step(
            Phase::Consolidate,
            PhaseOutcome::Success {
                output: serde_json::json!(null),
            },
        ));
        assert_eq!(next_phase(&s), None);
        assert!(s.completed);
    }

    #[test]
    fn skip_does_not_abort() {
        let mut s = PipelineState::new();
        s.record(step(
            Phase::Retrieve,
            PhaseOutcome::Skip {
                reason: "no hits".into(),
            },
        ));
        assert_eq!(next_phase(&s), Some(Phase::Judge));
        assert!(!s.aborted);
    }

    #[test]
    fn fail_aborts_pipeline() {
        let mut s = PipelineState::new();
        s.record(step(
            Phase::Retrieve,
            PhaseOutcome::Fail {
                reason: "store down".into(),
            },
        ));
        assert!(s.aborted);
        assert_eq!(next_phase(&s), None);
    }

    #[test]
    fn distill_fires_on_high_judge_score() {
        let out = serde_json::json!({ "judge_score": 0.85 });
        assert!(should_fire_distill(&out));
    }

    #[test]
    fn distill_does_not_fire_on_low_score() {
        let out = serde_json::json!({ "judge_score": 0.5 });
        assert!(!should_fire_distill(&out));
    }

    #[test]
    fn distill_does_not_fire_on_missing_score() {
        let out = serde_json::json!({ "other": "yes" });
        assert!(!should_fire_distill(&out));
    }
}
