// SPDX-License-Identifier: MIT
//
// Federation: multi-instance harness coordination.
//
// Per ADR-014 (Self-evolution + federation), a harness can talk to other
// instances of itself (or to other harnesses entirely) via a federated
// transport. The kernel owns:
//   - The PEER REGISTRY (who can we talk to?)
//   - The MESSAGE ENVELOPE shape (canonical so signatures verify cross-host)
//   - The CLAIMS check on every inbound message (per ADR-014 §security)
//
// The actual wire transport (WebSocket, QUIC, raw TCP) is a host-side
// concern — the kernel only owns the envelope + verification. This keeps
// the wasm bundle small (no transport pulled into wasm at all) and lets
// each host pick its preferred wire (browser: WebSocket; Node: QUIC via
// midstreamer; pi.dev: probably long-poll HTTP).

//! Federation: peer registry + message envelope + per-message auth.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A federated peer the kernel knows about.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Peer {
    /// Globally unique peer id (e.g. an Ed25519 public key hex).
    pub id: String,
    /// Human-readable name (matches the harness's package name).
    pub name: String,
    /// Wire endpoint the host transport can dial (URL, dns:port, etc.).
    pub endpoint: String,
    /// Trust tier: "trusted" peers skip claims check on read-only ops.
    pub trust: TrustTier,
}

/// Per-peer trust tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrustTier {
    /// Untrusted — every message requires a claim.
    Untrusted,
    /// Trusted — read-only operations skip the claims check.
    Trusted,
    /// Self — local instance, no claim required.
    SelfPeer,
}

/// A message exchanged between federated peers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    /// Sender peer id.
    pub from: String,
    /// Intended recipient peer id (or "*" for broadcast).
    pub to: String,
    /// Capability requested (per claims subsystem semantics).
    pub capability: String,
    /// Resource scope (optional).
    pub resource: Option<String>,
    /// Free-form JSON payload.
    pub payload: serde_json::Value,
    /// Unix-second timestamp (set by sender).
    pub timestamp: i64,
}

/// In-memory peer registry.
#[derive(Debug, Default, Clone)]
pub struct PeerRegistry {
    peers: BTreeMap<String, Peer>,
}

impl PeerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, p: Peer) -> crate::Result<()> {
        if p.id.is_empty() {
            return Err(crate::Error::Other("peer id is empty".into()));
        }
        if p.name.is_empty() {
            return Err(crate::Error::Other("peer name is empty".into()));
        }
        self.peers.insert(p.id.clone(), p);
        Ok(())
    }

    pub fn deregister(&mut self, id: &str) -> bool {
        self.peers.remove(id).is_some()
    }

    pub fn get(&self, id: &str) -> Option<&Peer> {
        self.peers.get(id)
    }

    pub fn list(&self) -> Vec<&Peer> {
        self.peers.values().collect()
    }

    pub fn list_trusted(&self) -> Vec<&Peer> {
        self.peers
            .values()
            .filter(|p| p.trust != TrustTier::Untrusted)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.peers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }
}

/// Decide whether an inbound message should be honored given:
///   - the sender's trust tier
///   - the claims attached to the message (verified separately)
///   - whether the capability is a "read-only" operation
///
/// Trust-tier shortcuts:
///   - SelfPeer: always allow (local).
///   - Trusted: allow if capability is read-only OR claims allowed.
///   - Untrusted: claims must allow.
pub fn admit_message(
    sender_trust: TrustTier,
    claims_decision: Option<crate::claims::AuthDecision>,
    capability: &str,
) -> AdmitDecision {
    if matches!(sender_trust, TrustTier::SelfPeer) {
        return AdmitDecision::Admit {
            reason: "self peer".into(),
        };
    }
    let is_read_only = is_read_only_capability(capability);
    if matches!(sender_trust, TrustTier::Trusted) && is_read_only {
        return AdmitDecision::Admit {
            reason: "trusted read-only".into(),
        };
    }
    match claims_decision {
        Some(crate::claims::AuthDecision::Allowed) => AdmitDecision::Admit {
            reason: "claim allowed".into(),
        },
        Some(crate::claims::AuthDecision::Denied { reason }) => AdmitDecision::Reject { reason },
        None => AdmitDecision::Reject {
            reason: "no claim supplied; sender not trusted".into(),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmitDecision {
    Admit { reason: String },
    Reject { reason: String },
}

fn is_read_only_capability(cap: &str) -> bool {
    matches!(
        cap,
        "memory.read"
            | "memory.search"
            | "peer.info"
            | "peer.ping"
            | "tool.list"
            | "registry.list"
            | "*"
    ) || cap.ends_with(".read")
        || cap.ends_with(".list")
        || cap.ends_with(".search")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str, trust: TrustTier) -> Peer {
        Peer {
            id: id.into(),
            name: format!("name-{id}"),
            endpoint: format!("wss://example.com/{id}"),
            trust,
        }
    }

    #[test]
    fn registry_register_get() {
        let mut r = PeerRegistry::new();
        r.register(peer("p1", TrustTier::Trusted)).unwrap();
        assert_eq!(r.get("p1").unwrap().name, "name-p1");
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn registry_deregister() {
        let mut r = PeerRegistry::new();
        r.register(peer("p1", TrustTier::Trusted)).unwrap();
        assert!(r.deregister("p1"));
        assert!(!r.deregister("p1")); // second time is a no-op
    }

    #[test]
    fn registry_rejects_empty_id() {
        let mut r = PeerRegistry::new();
        let mut p = peer("x", TrustTier::Untrusted);
        p.id = "".into();
        assert!(r.register(p).is_err());
    }

    #[test]
    fn registry_list_trusted_filters() {
        let mut r = PeerRegistry::new();
        r.register(peer("a", TrustTier::Trusted)).unwrap();
        r.register(peer("b", TrustTier::Untrusted)).unwrap();
        r.register(peer("c", TrustTier::SelfPeer)).unwrap();
        assert_eq!(r.list_trusted().len(), 2);
    }

    #[test]
    fn admit_self_peer_always() {
        let d = admit_message(TrustTier::SelfPeer, None, "tool.invoke");
        assert!(matches!(d, AdmitDecision::Admit { .. }));
    }

    #[test]
    fn admit_trusted_read_only_no_claim() {
        let d = admit_message(TrustTier::Trusted, None, "memory.read");
        assert!(matches!(d, AdmitDecision::Admit { .. }));
    }

    #[test]
    fn reject_trusted_write_no_claim() {
        let d = admit_message(TrustTier::Trusted, None, "memory.write");
        assert!(matches!(d, AdmitDecision::Reject { .. }));
    }

    #[test]
    fn reject_untrusted_read_no_claim() {
        let d = admit_message(TrustTier::Untrusted, None, "memory.read");
        assert!(matches!(d, AdmitDecision::Reject { .. }));
    }

    #[test]
    fn admit_with_allowed_claim() {
        let d = admit_message(
            TrustTier::Untrusted,
            Some(crate::claims::AuthDecision::Allowed),
            "memory.write",
        );
        assert!(matches!(d, AdmitDecision::Admit { .. }));
    }

    #[test]
    fn reject_with_denied_claim() {
        let d = admit_message(
            TrustTier::Untrusted,
            Some(crate::claims::AuthDecision::Denied {
                reason: "expired".into(),
            }),
            "memory.read",
        );
        assert!(matches!(d, AdmitDecision::Reject { reason } if reason == "expired"));
    }

    #[test]
    fn is_read_only_recognises_common_suffixes() {
        assert!(is_read_only_capability("memory.read"));
        assert!(is_read_only_capability("registry.list"));
        assert!(is_read_only_capability("anything.search"));
        assert!(!is_read_only_capability("memory.write"));
        assert!(!is_read_only_capability("tool.invoke"));
    }
}
