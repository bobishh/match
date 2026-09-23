use std::{collections::BTreeSet, str::FromStr};

use automerge::{AutoCommit, AutoSerde, ChangeHash};
use meta_mesh_core::{
    AuthorizedWorkspaceChange, ChangeAdmissionChange, ChangeAdmissionFlowInput, WorkspaceRole,
    WorkspaceWriteAuthorizationSnapshot, WriteEvidenceInput, admit_workspace_change_authorizations,
    plan_change_admission_flow, prepare_write_evidence,
};
use serde_json::{Value, json};

/// Merge incoming signed authority with the trusted local genesis anchor,
/// then verify the resulting ownership and revocation history in Rust.
pub fn prepare_match_write_authority(
    document: &[u8],
    incoming: &Value,
    known: Option<&Value>,
    records: &[Value],
    genesis_person_id: &str,
    now_ms: i128,
) -> Result<(WorkspaceWriteAuthorizationSnapshot, Value), String> {
    let doc =
        AutoCommit::load(document).map_err(|error| format!("Invalid Match document: {error}"))?;
    let raw = serde_json::to_value(AutoSerde::from(&doc)).map_err(|error| error.to_string())?;
    let workspace_id = raw
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid Match workspace id")?;
    let remote_owner_person_id = raw
        .get("ownerPersonId")
        .and_then(Value::as_str)
        .ok_or("Invalid Match genesis owner")?;
    let merged = prepare_write_evidence(WriteEvidenceInput {
        incoming: incoming.clone(),
        known: known.cloned(),
        records: records.to_vec(),
        genesis_person_id: genesis_person_id.to_string(),
        remote_owner_person_id: remote_owner_person_id.to_string(),
    })?;
    let snapshot = serde_json::from_value::<WorkspaceWriteAuthorizationSnapshot>(json!({
        "workspaceId": workspace_id,
        "genesisOwner": merged.get("genesisOwner"),
        "genesisEpoch": merged.get("genesisEpoch"),
        "expectedCurrentOwner": merged.get("currentOwner"),
        "document": document,
        "ownershipTransfers": merged.get("ownershipTransfers").cloned().unwrap_or_else(|| json!([])),
        "successionClaims": merged.get("successionClaims").cloned().unwrap_or_else(|| json!([])),
        "revocations": merged.get("revocations").cloned().unwrap_or_else(|| json!([])),
        "deviceRevocations": merged.get("deviceRevocations").cloned().unwrap_or_else(|| json!([])),
        "departures": merged.get("departures").cloned().unwrap_or_else(|| json!([])),
    }))
    .map_err(|_| "Invalid Match write authority evidence".to_string())?;
    admit_workspace_change_authorizations(&[], &snapshot, &[], now_ms)?;
    Ok((snapshot, merged))
}

/// Verify the exact newly received Match changes before a native peer writes
/// the candidate document or acknowledges its sender. `authority` comes from
/// trusted local storage; the incoming proof only supplies signed records.
pub fn admit_match_candidate(
    local: Option<&[u8]>,
    candidate: &[u8],
    accepted_hashes: &[String],
    proof: Option<&Value>,
    mut authority: WorkspaceWriteAuthorizationSnapshot,
    now_ms: i128,
) -> Result<Vec<Value>, String> {
    let proof = proof.ok_or("The peer needs an update: missing workspace authority evidence")?;
    if proof.get("version").and_then(Value::as_u64) != Some(1)
        || !proof.get("authority").is_some_and(Value::is_object)
    {
        return Err("The peer needs an update: missing workspace authority evidence".into());
    }
    let records = proof
        .get("records")
        .and_then(Value::as_array)
        .ok_or("The peer needs an update: missing workspace authority evidence")?
        .clone();
    if serde_json::to_vec(proof)
        .map_err(|error| error.to_string())?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("The peer needs an update: missing write authorizations".into());
    }
    let mut document =
        AutoCommit::load(candidate).map_err(|error| format!("Invalid Match document: {error}"))?;
    let json =
        serde_json::to_value(AutoSerde::from(&document)).map_err(|error| error.to_string())?;
    if json.get("id").and_then(Value::as_str) != Some(authority.workspace_id.as_str()) {
        return Err("Wrong workspace document".into());
    }
    if json.get("ownerPersonId").and_then(Value::as_str)
        != Some(authority.genesis_owner.person_id.as_str())
    {
        return Err("Match document genesis owner does not match signed authority".into());
    }
    let changes = document
        .get_changes(&[])
        .iter()
        .map(|change| ChangeAdmissionChange {
            hash: change.hash().to_string(),
            dependencies: change.deps().iter().map(ToString::to_string).collect(),
            actor: change.actor_id().to_string(),
            message: change.message().unwrap_or_default().to_string(),
        })
        .collect::<Vec<_>>();
    let known_hashes = if let Some(local) = local {
        let mut local = AutoCommit::load(local)
            .map_err(|error| format!("Invalid local Match document: {error}"))?;
        let local_json =
            serde_json::to_value(AutoSerde::from(&local)).map_err(|error| error.to_string())?;
        if local_json.get("id").and_then(Value::as_str) != Some(authority.workspace_id.as_str()) {
            return Err("Wrong local workspace document".into());
        }
        local
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().to_string())
            .collect()
    } else {
        Vec::new()
    };
    let known = known_hashes.iter().collect::<BTreeSet<_>>();
    let candidate_hashes = changes
        .iter()
        .map(|change| &change.hash)
        .collect::<BTreeSet<_>>();
    if !known.is_subset(&candidate_hashes) {
        return Err("Candidate Match history omits accepted local changes".into());
    }
    let incoming = changes
        .iter()
        .map(|change| &change.hash)
        .filter(|hash| !known.contains(hash))
        .collect::<BTreeSet<_>>();
    if incoming != accepted_hashes.iter().collect::<BTreeSet<_>>() {
        return Err("Accepted Match changes do not match candidate history".into());
    }
    authority.document = candidate.to_vec();
    let plan = plan_change_admission_flow(
        ChangeAdmissionFlowInput {
            records,
            known_hashes,
            changes,
            snapshot: authority,
        },
        now_ms,
    )?;
    let editor_changes = plan
        .editor_changes
        .iter()
        .map(|change| AuthorizedWorkspaceChange {
            hash: change.hash.clone(),
            role: WorkspaceRole::Editor,
        })
        .collect::<Vec<_>>();
    validate_change_transitions(candidate, &editor_changes)?;
    if let Some(error) = plan.unsigned_error {
        return Err(error);
    }
    Ok(plan.verified_authorizations)
}

/// Match product policy over the exact Automerge state before and after each
/// admitted change. Signed mesh grants are necessary but do not authorize
/// editor changes to board structure or ownership fields.
pub fn validate_change_transitions(
    document: &[u8],
    admitted: &[AuthorizedWorkspaceChange],
) -> Result<(), String> {
    let mut doc =
        AutoCommit::load(document).map_err(|error| format!("Invalid Match document: {error}"))?;
    for change in admitted {
        let hash = ChangeHash::from_str(&change.hash).map_err(|_| "Invalid Match change hash")?;
        let dependencies = doc
            .get_change_by_hash(&hash)
            .ok_or("Admitted Match change is missing from document")?
            .deps()
            .to_vec();
        let before = doc
            .fork_at(&dependencies)
            .map_err(|error| error.to_string())?;
        let after = doc.fork_at(&[hash]).map_err(|error| error.to_string())?;
        let before =
            serde_json::to_value(AutoSerde::from(&before)).map_err(|error| error.to_string())?;
        let after =
            serde_json::to_value(AutoSerde::from(&after)).map_err(|error| error.to_string())?;
        validate_workspace_transition(change.role, &before, &after)?;
    }
    Ok(())
}

/// Same product transition rules used by Match's browser adapter.
pub fn validate_workspace_transition(
    role: WorkspaceRole,
    before: &Value,
    after: &Value,
) -> Result<(), String> {
    if role == WorkspaceRole::Visitor {
        return Err("Visitors can only view this workspace".into());
    }
    let before = before
        .as_object()
        .ok_or("Invalid Match workspace before change")?;
    let after = after
        .as_object()
        .ok_or("Invalid Match workspace after change")?;
    let mut before_root = before.clone();
    let mut after_root = after.clone();
    before_root.remove("title");
    after_root.remove("title");
    let before_entities = before_root
        .remove("entities")
        .and_then(|value| value.as_object().cloned())
        .ok_or("Invalid Match entities before change")?;
    let after_entities = after_root
        .remove("entities")
        .and_then(|value| value.as_object().cloned())
        .ok_or("Invalid Match entities after change")?;
    if before_root != after_root && role != WorkspaceRole::Owner {
        return Err("Only the owner can edit board structure".into());
    }
    let ids = before_entities
        .keys()
        .chain(after_entities.keys())
        .collect::<BTreeSet<_>>();
    for id in ids {
        let old = before_entities.get(id);
        let new = after_entities.get(id);
        if old == new {
            continue;
        }
        if !is_content_change(old, new) {
            if role != WorkspaceRole::Owner {
                return Err("Only the owner can edit board structure".into());
            }
            continue;
        }
        if is_item(new.unwrap()) {
            let parent_id = new
                .unwrap()
                .pointer("/placement/parentId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let parent = after_entities.get(parent_id);
            if !parent.is_some_and(|value| {
                is_item(value) || value.get("kind").and_then(Value::as_str) == Some("column")
            }) {
                return Err("Invalid item parent".into());
            }
        }
    }
    Ok(())
}

fn is_content_change(before: Option<&Value>, after: Option<&Value>) -> bool {
    let Some(after) = after else {
        return false;
    };
    let kind = entity_kind(after);
    matches!(kind, Some("item" | "document" | "artifact"))
        && (before.is_none() || before.and_then(entity_kind) == kind)
}

fn entity_kind(value: &Value) -> Option<&str> {
    if is_item(value) {
        Some("item")
    } else {
        value.get("kind").and_then(Value::as_str)
    }
}

fn is_item(value: &Value) -> bool {
    let Some(value) = value.as_object() else {
        return false;
    };
    ["id", "title", "body"]
        .iter()
        .all(|key| value.get(*key).is_some_and(Value::is_string))
        && ["values", "placement"]
            .iter()
            .all(|key| value.get(*key).is_some_and(Value::is_object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{ObjType, ROOT, transaction::Transactable};
    use meta_mesh_core::{
        DEFAULT_SIGNATURE_DOMAIN, DeviceCertificatePayload, WorkspaceAuthority, WorkspaceRole,
        public_key_from_seed, public_key_id, sign_device_certificate,
    };
    use serde_json::json;

    fn board() -> Value {
        json!({"id":"board", "ownerPersonId":"owner", "title":"Jobs", "entities":{
            "column":{"kind":"column", "id":"column", "title":"Inbox"},
            "item":{"id":"item", "title":"Lead", "body":"Old", "values":{}, "placement":{"parentId":"column", "rank":"a"}}
        }})
    }

    #[test]
    fn editor_content_allowed_but_owner_and_structure_changes_denied() {
        let before = board();
        let mut after = before.clone();
        after["entities"]["item"]["body"] = json!("New");
        validate_workspace_transition(WorkspaceRole::Editor, &before, &after).unwrap();
        after["ownerPersonId"] = json!("editor");
        assert!(validate_workspace_transition(WorkspaceRole::Editor, &before, &after).is_err());
        after = before.clone();
        after["entities"]["column"]["title"] = json!("Changed");
        assert!(validate_workspace_transition(WorkspaceRole::Editor, &before, &after).is_err());
    }

    #[test]
    fn item_parent_must_exist_even_for_owner() {
        let before = board();
        let mut after = before.clone();
        after["entities"]["item"]["placement"]["parentId"] = json!("missing");
        assert_eq!(
            validate_workspace_transition(WorkspaceRole::Owner, &before, &after),
            Err("Invalid item parent".into())
        );
    }

    #[test]
    fn validates_each_admitted_automerge_change_at_its_own_heads() {
        let mut document = AutoCommit::new();
        document.put(ROOT, "id", "board").unwrap();
        document.put(ROOT, "ownerPersonId", "owner").unwrap();
        document.put(ROOT, "title", "Jobs").unwrap();
        document.put_object(ROOT, "entities", ObjType::Map).unwrap();
        document.get_heads();

        document.put(ROOT, "title", "Jobs updated").unwrap();
        let title_hash = document.get_heads()[0].to_string();
        document.put(ROOT, "ownerPersonId", "editor").unwrap();
        let owner_hash = document.get_heads()[0].to_string();
        let bytes = document.save();

        validate_change_transitions(
            &bytes,
            &[AuthorizedWorkspaceChange {
                hash: title_hash,
                role: WorkspaceRole::Editor,
            }],
        )
        .unwrap();
        assert_eq!(
            validate_change_transitions(
                &bytes,
                &[AuthorizedWorkspaceChange {
                    hash: owner_hash,
                    role: WorkspaceRole::Editor,
                }]
            ),
            Err("Only the owner can edit board structure".into())
        );
    }

    #[test]
    fn prepares_signed_owner_authority_for_a_match_document() {
        let person_key = public_key_from_seed(&[1; 32]).unwrap();
        let person_id = public_key_id(&person_key).unwrap();
        let device_key = public_key_from_seed(&[2; 32]).unwrap();
        let device_id = public_key_id(&device_key).unwrap();
        let certificate = sign_device_certificate(
            &[1; 32],
            DeviceCertificatePayload {
                kind: "device-certificate".into(),
                version: 1,
                person_id: person_id.clone(),
                device_id,
                device_public_key: device_key,
                issuer_certificate_hash: None,
                can_enroll_devices: true,
            },
            &person_id,
            DEFAULT_SIGNATURE_DOMAIN,
        )
        .unwrap();
        let owner = WorkspaceAuthority {
            person_id: person_id.clone(),
            public_key: person_key,
            certificates: vec![certificate],
        };
        let mut document = AutoCommit::new();
        document.put(ROOT, "id", "board").unwrap();
        document
            .put(ROOT, "ownerPersonId", person_id.clone())
            .unwrap();
        let evidence = json!({
            "genesisOwner": owner,
            "genesisEpoch": 1,
            "currentOwner": owner,
            "currentEpoch": 1,
            "ownershipTransfers": [],
            "successionClaims": [],
            "revocations": [],
            "deviceRevocations": [],
            "departures": [],
        });
        let (snapshot, merged) =
            prepare_match_write_authority(&document.save(), &evidence, None, &[], &person_id, 0)
                .unwrap();
        assert_eq!(snapshot.workspace_id, "board");
        assert_eq!(snapshot.expected_current_owner.person_id, person_id);
        assert_eq!(merged, evidence);
    }
}
