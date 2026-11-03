use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftKind {
    Table,
    Mermaid,
    Math,
    Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOpening {
    pub base_revision: u64,
    pub start_byte: u32,
    pub end_byte: u32,
    pub opening_text: String,
    pub kind: DraftKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftUpdate {
    pub generation: u64,
    pub text: String,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftLease {
    pub doc_id: String,
    pub token: String,
    pub owner_window: Option<String>,
    pub opening: DraftOpening,
    pub generation: u64,
    pub text: String,
    pub valid: bool,
}

impl DraftLease {
    fn authorize(&self, owner: &str, token: &str) -> Result<(), String> {
        if self.owner_window.as_deref() != Some(owner) || self.token != token {
            return Err(
                "draft ownership changed; preserve the draft and reopen or resolve its owner"
                    .into(),
            );
        }
        Ok(())
    }
}

impl DocumentRegistry {
    pub fn draft_info(&self, id: &str) -> Option<DraftLease> {
        self.lock().docs.get(id)?.draft.clone()
    }

    pub fn acquire_draft(
        &self,
        id: &str,
        owner: &str,
        opening: DraftOpening,
    ) -> Result<DraftLease, String> {
        let mut inner = self.lock();
        let entry = inner.docs.get(id).ok_or("unknown document")?;
        if let Some(lease) = &entry.draft {
            return Err(format!(
                "resolve current draft first (Apply / Discard / switch to owner {:?})",
                lease.owner_window
            ));
        }
        if owner.is_empty()
            || opening.base_revision != entry.revision
            || opening.start_byte > opening.end_byte
            || entry
                .content
                .get(opening.start_byte as usize..opening.end_byte as usize)
                != Some(opening.opening_text.as_str())
        {
            return Err("stale or invalid draft opening range".into());
        }
        inner.draft_counter = inner
            .draft_counter
            .checked_add(1)
            .ok_or("draft token counter exhausted")?;
        let lease = DraftLease {
            doc_id: id.into(),
            token: format!("draft-{}", inner.draft_counter),
            owner_window: Some(owner.into()),
            text: opening.opening_text.clone(),
            opening,
            generation: 0,
            valid: false,
        };
        inner.docs.get_mut(id).unwrap().draft = Some(lease.clone());
        Ok(lease)
    }

    pub fn update_draft(
        &self,
        id: &str,
        owner: &str,
        token: &str,
        update: DraftUpdate,
    ) -> Result<DraftLease, String> {
        let mut inner = self.lock();
        let lease = inner
            .docs
            .get_mut(id)
            .and_then(|entry| entry.draft.as_mut())
            .ok_or("no active draft")?;
        lease.authorize(owner, token)?;
        if update.generation < lease.generation
            || (update.generation == lease.generation && update.text != lease.text)
        {
            return Err("stale draft update".into());
        }
        lease.generation = update.generation;
        lease.text = update.text;
        lease.valid = update.valid;
        Ok(lease.clone())
    }

    pub fn release_draft(&self, id: &str, owner: &str, token: &str) -> Result<(), String> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id).ok_or("unknown document")?;
        entry
            .draft
            .as_ref()
            .ok_or("no active draft")?
            .authorize(owner, token)?;
        entry.draft = None;
        Ok(())
    }

    /// Modified, acknowledged text survives owner destruction in memory. Disk
    /// recovery and its opt-in UI are package E; clean leases need no recovery.
    pub fn detach_window_drafts(&self, owner: &str) -> Vec<String> {
        let mut inner = self.lock();
        let mut changed = Vec::new();
        for (id, entry) in &mut inner.docs {
            if let Some(lease) = &mut entry.draft {
                if lease.owner_window.as_deref() == Some(owner) {
                    if lease.text == lease.opening.opening_text {
                        entry.draft = None;
                    } else {
                        lease.owner_window = None;
                        lease.valid = false;
                    }
                    changed.push(id.clone());
                }
            }
        }
        changed
    }

    pub fn resume_draft(&self, id: &str, owner: &str, token: &str) -> Result<DraftLease, String> {
        let mut inner = self.lock();
        let lease = inner
            .docs
            .get(id)
            .and_then(|entry| entry.draft.as_ref())
            .ok_or("no orphaned draft")?;
        if owner.is_empty() || lease.owner_window.is_some() || lease.token != token {
            return Err("only an orphaned draft can be resumed".into());
        }
        inner.draft_counter = inner
            .draft_counter
            .checked_add(1)
            .ok_or("draft token counter exhausted")?;
        let next_token = format!("draft-{}", inner.draft_counter);
        let lease = inner.docs.get_mut(id).unwrap().draft.as_mut().unwrap();
        lease.owner_window = Some(owner.into());
        lease.token = next_token;
        lease.valid = false;
        Ok(lease.clone())
    }

    /// Source edits remain possible, making the draft stale. Direct localized
    /// edits cannot race the active draft; stale ranges conservatively block all.
    pub fn apply_localized_transaction(
        &self,
        id: &str,
        tx: &WireTransaction,
    ) -> Result<TransactionRecord, crate::documents::ApplyError> {
        let mut inner = self.lock();
        let entry = inner
            .docs
            .get_mut(id)
            .ok_or_else(|| crate::documents::ApplyError::UnknownDoc(id.into()))?;
        if let Some(lease) = &entry.draft {
            if entry.revision != lease.opening.base_revision
                || tx.ops.iter().any(|op| {
                    op.start_byte <= lease.opening.end_byte
                        && op.end_byte >= lease.opening.start_byte
                })
            {
                return Err(crate::documents::ApplyError::ActiveDraft);
            }
        }
        Self::apply_entry(entry, tx)
    }

    /// Ownership, acknowledged validation, range, commit and release all share
    /// one lock. Failed checks never release a lease or mutate history/content.
    pub fn apply_draft(
        &self,
        id: &str,
        owner: &str,
        token: &str,
        generation: u64,
        ops: Vec<DocOp>,
    ) -> Result<Option<TransactionRecord>, String> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id).ok_or("unknown document")?;
        let lease = entry.draft.as_ref().ok_or("no active draft")?;
        lease.authorize(owner, token)?;
        let opening = &lease.opening;
        if !lease.valid || generation != lease.generation {
            return Err(
                "draft is invalid or validation has not acknowledged this generation".into(),
            );
        }
        if entry.revision != opening.base_revision
            || entry
                .content
                .get(opening.start_byte as usize..opening.end_byte as usize)
                != Some(opening.opening_text.as_str())
        {
            return Err(
                "stale draft; copy the draft and reopen, or Cancel (no automatic overwrite)".into(),
            );
        }
        if lease.text == opening.opening_text {
            if !ops.is_empty() {
                return Err("unchanged Apply must have no operations".into());
            }
            entry.draft = None;
            return Ok(None);
        }
        Self::validate_ops(&entry.content, &ops).map_err(|error| error.to_string())?;
        let mut replacement = opening.opening_text.clone();
        for op in ops.iter().rev() {
            if op.start_byte < opening.start_byte || op.end_byte > opening.end_byte {
                return Err("draft operation escapes its opening range".into());
            }
            replacement.replace_range(
                (op.start_byte - opening.start_byte) as usize
                    ..(op.end_byte - opening.start_byte) as usize,
                &op.text,
            );
        }
        if replacement != lease.text {
            return Err("operations do not match acknowledged draft text".into());
        }
        let revision = opening.base_revision;
        let record = Self::apply_entry(
            entry,
            &WireTransaction {
                base_revision: revision,
                ops,
            },
        )
        .map_err(|error| error.to_string())?;
        entry.draft = None;
        Ok(Some(record))
    }
}

impl DocumentRegistry {
    pub fn discard_orphan(&self, id: &str, token: &str) -> Result<(), String> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id).ok_or("unknown recovered document")?;
        if !entry
            .draft
            .as_ref()
            .is_some_and(|lease| lease.owner_window.is_none() && lease.token == token)
        {
            return Err("recovered draft ownership changed".into());
        }
        entry.draft = None;
        Ok(())
    }

    pub fn restore_draft(&self, id: &str, mut lease: DraftLease) -> Result<(), String> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id).ok_or("unknown recovered document")?;
        if entry.draft.is_some()
            || entry
                .content
                .get(lease.opening.start_byte as usize..lease.opening.end_byte as usize)
                != Some(lease.opening.opening_text.as_str())
        {
            return Err("recovered draft range does not match its canonical base".into());
        }
        lease.token = format!("recovered-{id}");
        lease.doc_id = id.into();
        lease.opening.base_revision = entry.revision;
        lease.owner_window = None;
        lease.valid = false;
        entry.draft = Some(lease);
        Ok(())
    }
}
