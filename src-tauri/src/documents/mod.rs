//! DocumentService + DocumentRegistry (ADR-004, ADR-006, ADR-007).
//!
//! Canonical document state lives here (process-lifetime, shared by all
//! windows). All mutations are revision-checked, char-boundary-validated,
//! op-based transactions.

pub(crate) mod recovery;
pub(crate) mod registry;
pub(crate) mod service;

#[cfg(test)]
mod tests;

pub use recovery::{RecoveryInfo, RecoveryStore};
pub use registry::{
    wire_ops, AppliedOp, DocEntry, DocId, DocumentRegistry, DocumentUpdate, DraftKind, DraftLease,
    DraftOpening, DraftUpdate, NewlinePolicy, OpValidationError, TransactionRecord,
};
pub use service::{DiskRevision, DocumentSnapshot, OpenError, SaveError, SaveResult};

use serde::{Deserialize, Serialize};

/// A single text replacement on the canonical buffer, addressed in **UTF-8
/// byte offsets** (ADR-010: the wire format is byte-based; the frontend maps
/// from UTF-16 at its boundary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOp {
    /// Start byte offset (inclusive). Must be a char boundary.
    pub start_byte: u32,
    /// End byte offset (exclusive). Must be a char boundary, `>= start_byte`.
    pub end_byte: u32,
    /// Replacement text (UTF-8). Empty text = deletion; `start == end` =
    /// insertion.
    pub text: String,
}

/// Wire form of a transaction: the client's base revision plus the ops to
/// apply atomically. One wire transaction = one document undo group
/// (ADR-007).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTransaction {
    pub base_revision: u64,
    /// Ops in ascending, non-overlapping order (validated; fail closed).
    pub ops: Vec<DocOp>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("unknown document {0}")]
    UnknownDoc(DocId),
    #[error("stale revision: expected {expected}, document is at {actual}")]
    StaleRevision { expected: u64, actual: u64 },
    #[error("invalid op: {0}")]
    InvalidOp(#[from] OpValidationError),
    #[error("active draft protects this source range")]
    ActiveDraft,
    #[error("document not found on disk")]
    NotOnDisk,
}
