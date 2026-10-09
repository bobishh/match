use std::{collections::BTreeSet, str::FromStr};

use automerge::{AutoCommit, AutoSerde, ChangeHash};
use meta_mesh_core::causal_admission::{
    CausalAdmissionDecision, CausalAdmissionInput, CausalAdmissionStatus, evaluate_causal_admission,
};
use meta_mesh_core::{
    AuthorizedWorkspaceChange, ChangeAdmissionChange, ChangeAdmissionFlowInput, WorkspaceRole,
    WorkspaceWriteAuthorizationSnapshot, WriteEvidenceInput, admit_workspace_change_authorizations,
    plan_change_admission_flow, prepare_write_evidence,
};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TincanbanCandidateAdmission {
    /// Exact signed authorization records verified against the raw candidate.
    pub verified_authorizations: Vec<Value>,
    /// Full change-by-change classification. Unsigned or invalid changes remain
    /// quarantine evidence; callers must not use them for product state.
    pub decisions: Vec<CausalAdmissionDecision>,
    /// Rebuilt document containing only admitted changes and their dependency
    /// closure. The raw candidate remains caller-owned evidence.
    pub authorized_document: Vec<u8>,
    /// Authority accepted against this exact candidate and workspace genesis.
    pub verified_authority: WorkspaceWriteAuthorizationSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRevocationCompletion {
    pub workspace_id: String,
    pub owner_person_id: String,
    pub revoked_person_id: String,
    pub revocation_epoch: u64,
    pub revocation: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedKeeperGrant {
    pub workspace_id: String,
    pub owner_person_id: String,
    pub member_person_id: String,
    pub role: String,
    pub grant_epoch: u64,
    pub grant: Value,
}

/// Merge incoming signed authority with the trusted local genesis anchor,
/// then verify the resulting ownership and revocation history in Rust.
pub fn prepare_tincanban_write_authority(
    document: &[u8],
    incoming: &Value,
    known: Option<&Value>,
    records: &[Value],
    genesis_person_id: &str,
    now_ms: i128,
) -> Result<(WorkspaceWriteAuthorizationSnapshot, Value), String> {
    let doc = AutoCommit::load(document)
        .map_err(|error| format!("Invalid tincanban document: {error}"))?;
    let raw = serde_json::to_value(AutoSerde::from(&doc)).map_err(|error| error.to_string())?;
    let workspace_id = raw
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid tincanban workspace id")?;
    let remote_owner_person_id = raw
        .get("ownerPersonId")
        .and_then(Value::as_str)
        .ok_or("Invalid tincanban genesis owner")?;
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
    .map_err(|_| "Invalid tincanban write authority evidence".to_string())?;
    admit_workspace_change_authorizations(&[], &snapshot, &[], now_ms)?;
    Ok((snapshot, merged))
}

/// Verify the exact newly received tincanban changes before a native peer writes
/// the candidate document or acknowledges its sender. `authority` comes from
/// trusted local storage; the incoming proof only supplies signed records.
pub fn admit_tincanban_candidate(
    local: Option<&[u8]>,
    candidate: &[u8],
    accepted_hashes: &[String],
    proof: Option<&Value>,
    mut authority: WorkspaceWriteAuthorizationSnapshot,
    now_ms: i128,
) -> Result<TincanbanCandidateAdmission, String> {
    let proof = proof.ok_or("The peer needs an update: missing workspace authority evidence")?;
    if !matches!(proof.get("version").and_then(Value::as_u64), Some(1 | 2))
        || !proof.get("authority").is_some_and(Value::is_object)
    {
        return Err("The peer needs an update: missing workspace authority evidence".into());
    }
    let pages = meta_mesh_core::authorization_record_pages(proof)?;
    let paged = proof.get("version").and_then(Value::as_u64) == Some(2);
    let mut document = AutoCommit::load(candidate)
        .map_err(|error| format!("Invalid tincanban document: {error}"))?;
    let json =
        serde_json::to_value(AutoSerde::from(&document)).map_err(|error| error.to_string())?;
    if json.get("id").and_then(Value::as_str) != Some(authority.workspace_id.as_str()) {
        return Err("Wrong workspace document".into());
    }
    if json.get("ownerPersonId").and_then(Value::as_str)
        != Some(authority.genesis_owner.person_id.as_str())
    {
        return Err("tincanban document genesis owner does not match signed authority".into());
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
            .map_err(|error| format!("Invalid local tincanban document: {error}"))?;
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
        return Err("Candidate tincanban history omits accepted local changes".into());
    }
    let incoming = changes
        .iter()
        .map(|change| &change.hash)
        .filter(|hash| !known.contains(hash))
        .collect::<BTreeSet<_>>();
    if incoming != accepted_hashes.iter().collect::<BTreeSet<_>>() {
        return Err("Accepted tincanban changes do not match candidate history".into());
    }
    authority.document = candidate.to_vec();
    let plan = plan_change_admission_flow(
        ChangeAdmissionFlowInput {
            records: if paged { Vec::new() } else { pages[0].clone() },
            record_pages: if paged { Some(pages) } else { None },
            known_hashes,
            changes,
            snapshot: authority.clone(),
        },
        now_ms,
    )?;
    let mut verified_authority = authority;
    verified_authority.document = candidate.to_vec();
    let causal = evaluate_causal_admission(CausalAdmissionInput {
        records: plan
            .verified_authorizations
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Invalid workspace change authorization".to_string())?,
        snapshot: verified_authority.clone(),
        pending_change_bytes: vec![],
        now_ms,
    })?;
    let editor_changes = causal
        .decisions
        .iter()
        .filter_map(|decision| {
            matches!(
                decision.status,
                CausalAdmissionStatus::Admitted {
                    role: WorkspaceRole::Editor
                }
            )
            .then(|| AuthorizedWorkspaceChange {
                hash: decision.hash.clone(),
                role: WorkspaceRole::Editor,
            })
        })
        .collect::<Vec<_>>();
    validate_change_transitions(candidate, &editor_changes)?;
    let verified_authorizations = causal
        .verified_authorizations
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Invalid workspace change authorization".to_string())?;
    Ok(TincanbanCandidateAdmission {
        verified_authorizations,
        decisions: causal.decisions,
        authorized_document: causal.authorized_document,
        verified_authority,
    })
}

/// Verify an owner-authored revocation proof for withdrawal completion.
/// Caller supplies raw Automerge history and the normal workspace authorization
/// bundle; neither a claimed epoch nor a claimed record hash is trusted.
pub fn verify_revocation_completion(
    raw_document: &[u8],
    authorization_bundle: &Value,
    expected_owner_person_id: &str,
    target_person_id: &str,
    now_ms: i128,
) -> Result<VerifiedRevocationCompletion, String> {
    let genesis_person_id = authorization_bundle
        .pointer("/authority/genesisOwner/personId")
        .and_then(Value::as_str)
        .ok_or("Missing workspace genesis owner")?;
    let incoming_authority = authorization_bundle
        .get("authority")
        .ok_or("Missing workspace authority evidence")?;
    let records = meta_mesh_core::authorization_records(authorization_bundle)?;
    let (snapshot, _) = prepare_tincanban_write_authority(
        raw_document,
        incoming_authority,
        None,
        &records,
        genesis_person_id,
        now_ms,
    )?;
    if snapshot.expected_current_owner.person_id != expected_owner_person_id {
        return Err("Workspace revocation owner does not match the pairing controller".into());
    }
    let mut document = AutoCommit::load(raw_document)
        .map_err(|error| format!("Invalid Tincanban document: {error}"))?;
    let hashes = document
        .get_changes(&[])
        .iter()
        .map(|change| change.hash().to_string())
        .collect::<Vec<_>>();
    let admission = admit_tincanban_candidate(
        None,
        raw_document,
        &hashes,
        Some(authorization_bundle),
        snapshot,
        now_ms,
    )?;
    let revocation = admission
        .verified_authority
        .revocations
        .iter()
        .filter(|record| record.payload.person_id == target_person_id)
        .max_by_key(|record| record.payload.epoch)
        .ok_or("Workspace has no verified revocation for the keeper")?;
    Ok(VerifiedRevocationCompletion {
        workspace_id: admission.verified_authority.workspace_id,
        owner_person_id: admission
            .verified_authority
            .expected_current_owner
            .person_id,
        revoked_person_id: revocation.payload.person_id.clone(),
        revocation_epoch: revocation.payload.epoch,
        revocation: serde_json::to_value(revocation).map_err(|error| error.to_string())?,
    })
}

/// Verify original owner-signed keeper grant against current workspace authority.
/// Rusty uses result epoch to fence a withdrawal before its first response.
pub fn verify_keeper_grant(
    raw_document: &[u8],
    authorization_bundle: &Value,
    grant_value: &Value,
    expected_owner_person_id: &str,
    target_person_id: &str,
    now_ms: i128,
) -> Result<VerifiedKeeperGrant, String> {
    let genesis_person_id = authorization_bundle
        .pointer("/authority/genesisOwner/personId")
        .and_then(Value::as_str)
        .ok_or("Missing workspace genesis owner")?;
    let incoming_authority = authorization_bundle
        .get("authority")
        .ok_or("Missing workspace authority evidence")?;
    let records = meta_mesh_core::authorization_records(authorization_bundle)?;
    let (snapshot, _) = prepare_tincanban_write_authority(
        raw_document,
        incoming_authority,
        None,
        &records,
        genesis_person_id,
        now_ms,
    )?;
    let owner = &snapshot.expected_current_owner;
    if owner.person_id != expected_owner_person_id {
        return Err("Keeper grant owner does not match the pairing controller".into());
    }
    let grant = serde_json::from_value::<meta_mesh_core::WorkspaceGrant>(grant_value.clone())
        .map_err(|_| "Invalid signed keeper grant".to_string())?;
    let identity = meta_mesh_core::PublicIdentity {
        person_id: owner.person_id.clone(),
        public_key: owner.public_key.clone(),
        display_name: String::new(),
    };
    let role = meta_mesh_core::verify_workspace_grant(
        &grant,
        &snapshot.workspace_id,
        target_person_id,
        &identity,
        &owner.certificates,
    )?;
    if role != WorkspaceRole::Editor {
        return Err("Keeper grant must authorize editor access".into());
    }
    Ok(VerifiedKeeperGrant {
        workspace_id: snapshot.workspace_id,
        owner_person_id: owner.person_id.clone(),
        member_person_id: grant.payload.person_id.clone(),
        role: "editor".into(),
        grant_epoch: grant.payload.effective_access_epoch(),
        grant: serde_json::to_value(grant).map_err(|error| error.to_string())?,
    })
}

/// tincanban product policy over the exact Automerge state before and after each
/// admitted change. Signed mesh grants are necessary but do not authorize
/// editor changes to board structure or ownership fields.
pub fn validate_change_transitions(
    document: &[u8],
    admitted: &[AuthorizedWorkspaceChange],
) -> Result<(), String> {
    let mut doc = AutoCommit::load(document)
        .map_err(|error| format!("Invalid tincanban document: {error}"))?;
    for change in admitted {
        let hash =
            ChangeHash::from_str(&change.hash).map_err(|_| "Invalid tincanban change hash")?;
        let dependencies = doc
            .get_change_by_hash(&hash)
            .ok_or("Admitted tincanban change is missing from document")?
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

/// Same product transition rules used by tincanban's browser adapter.
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
        .ok_or("Invalid tincanban workspace before change")?;
    let after = after
        .as_object()
        .ok_or("Invalid tincanban workspace after change")?;
    let mut before_root = before.clone();
    let mut after_root = after.clone();
    before_root.remove("title");
    after_root.remove("title");
    let before_entities = before_root
        .remove("entities")
        .and_then(|value| value.as_object().cloned())
        .ok_or("Invalid tincanban entities before change")?;
    let after_entities = after_root
        .remove("entities")
        .and_then(|value| value.as_object().cloned())
        .ok_or("Invalid tincanban entities after change")?;
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
    use automerge::{ObjType, ROOT, ReadDoc, transaction::Transactable};
    use meta_mesh_core::{
        DEFAULT_SIGNATURE_DOMAIN, DeviceCertificatePayload, WorkspaceAuthority,
        WorkspaceChangeAuthorizationPayload, WorkspaceRole, public_key_from_seed, public_key_id,
        sign_device_certificate, sign_json_envelope,
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
    fn prepares_signed_owner_authority_for_a_tincanban_document() {
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
        let (snapshot, merged) = prepare_tincanban_write_authority(
            &document.save(),
            &evidence,
            None,
            &[],
            &person_id,
            0,
        )
        .unwrap();
        assert_eq!(snapshot.workspace_id, "board");
        assert_eq!(snapshot.expected_current_owner.person_id, person_id);
        assert_eq!(merged, evidence);
    }

    #[test]
    fn verifies_original_owner_signed_editor_grant_and_rejects_foreign_scope() {
        let owner_key = public_key_from_seed(&[1; 32]).unwrap();
        let owner_id = public_key_id(&owner_key).unwrap();
        let device_key = public_key_from_seed(&[2; 32]).unwrap();
        let device_id = public_key_id(&device_key).unwrap();
        let certificate = sign_device_certificate(
            &[1; 32],
            DeviceCertificatePayload {
                kind: "device-certificate".into(),
                version: 1,
                person_id: owner_id.clone(),
                device_id: device_id.clone(),
                device_public_key: device_key,
                issuer_certificate_hash: None,
                can_enroll_devices: true,
            },
            &owner_id,
            DEFAULT_SIGNATURE_DOMAIN,
        )
        .unwrap();
        let owner = WorkspaceAuthority {
            person_id: owner_id.clone(),
            public_key: owner_key,
            certificates: vec![certificate],
        };
        let mut document = AutoCommit::new();
        document.put(ROOT, "id", "board").unwrap();
        document
            .put(ROOT, "ownerPersonId", owner_id.clone())
            .unwrap();
        let bytes = document.save();
        let authority = json!({ "genesisOwner": owner, "genesisEpoch": 1, "currentOwner": owner,
            "currentEpoch": 1, "ownershipTransfers": [], "successionClaims": [], "revocations": [],
            "deviceRevocations": [], "departures": [] });
        let bundle = json!({ "version": 1, "records": [], "authority": authority });
        let grant = serde_json::to_value(
            sign_json_envelope(
                &[2; 32],
                json!({ "kind": "workspace-grant", "version": 1,
            "grantId": "grant-1", "workspaceId": "board", "personId": "keeper", "role": "editor",
            "accessEpoch": 7 }),
                &device_id,
                DEFAULT_SIGNATURE_DOMAIN,
            )
            .unwrap(),
        )
        .unwrap();
        let verified =
            verify_keeper_grant(&bytes, &bundle, &grant, &owner_id, "keeper", 0).unwrap();
        assert_eq!(verified.grant_epoch, 7);
        assert_eq!(verified.workspace_id, "board");
        assert_eq!(verified.role, "editor");
        assert!(
            verify_keeper_grant(&bytes, &bundle, &grant, &owner_id, "other-keeper", 0).is_err()
        );
        assert!(
            verify_keeper_grant(&bytes, &bundle, &grant, "foreign-owner", "keeper", 0).is_err()
        );
    }

    #[test]
    fn retains_unsigned_history_but_returns_only_the_verified_projection() {
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
                device_id: device_id.clone(),
                device_public_key: device_key.clone(),
                issuer_certificate_hash: None,
                can_enroll_devices: true,
            },
            &person_id,
            DEFAULT_SIGNATURE_DOMAIN,
        )
        .unwrap();
        let owner = WorkspaceAuthority {
            person_id: person_id.clone(),
            public_key: person_key.clone(),
            certificates: vec![certificate.clone()],
        };
        let mut evidence = json!({
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
        let mut doc = AutoCommit::new();
        doc.set_actor(automerge::ActorId::from(device_id.as_bytes().to_vec()));
        doc.put(ROOT, "id", "board").unwrap();
        doc.put(ROOT, "ownerPersonId", person_id.clone()).unwrap();
        doc.put(ROOT, "title", "Trusted title").unwrap();
        let baseline_hash = doc.get_heads()[0].to_string();
        evidence["revocations"] = json!([sign_json_envelope(
            &[1; 32],
            json!({
                "kind": "workspace-revocation", "version": 1, "workspaceId": "board",
                "ownerPersonId": person_id, "personId": "service", "epoch": 4,
                "workspaceHeads": [baseline_hash], "revokedAt": "1970-01-01T00:00:00.000Z"
            }),
            &person_id,
            DEFAULT_SIGNATURE_DOMAIN,
        )
        .unwrap()]);
        doc.put(ROOT, "title", "Unsigned title").unwrap();
        let candidate = doc.save();
        let accepted_hashes = doc
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().to_string())
            .collect::<Vec<_>>();
        let authorization = sign_json_envelope(
            &[2; 32],
            serde_json::to_value(WorkspaceChangeAuthorizationPayload {
                kind: "workspace-changes".into(),
                version: 1,
                workspace_id: "board".into(),
                hashes: vec![baseline_hash],
                person_id,
                device_id: device_id.clone(),
            })
            .unwrap(),
            &device_id,
            DEFAULT_SIGNATURE_DOMAIN,
        )
        .unwrap();
        let proof = json!({
            "version": 1,
            "records": [{"signed": authorization, "publicKey": person_key, "certificates": [certificate]}],
            "authority": evidence,
        });
        let snapshot = serde_json::from_value(json!({
            "workspaceId": "board",
            "genesisOwner": owner,
            "genesisEpoch": 1,
            "expectedCurrentOwner": owner,
            "document": candidate,
            "ownershipTransfers": [],
            "successionClaims": [],
            "revocations": evidence["revocations"].clone(),
            "deviceRevocations": [],
            "departures": [],
        }))
        .unwrap();

        let admission = admit_tincanban_candidate(
            None,
            &candidate,
            &accepted_hashes,
            Some(&proof),
            snapshot,
            0,
        )
        .unwrap();
        let raw = AutoCommit::load(&candidate).unwrap();
        let admitted = AutoCommit::load(&admission.authorized_document).unwrap();
        assert_eq!(
            raw.get(ROOT, "title")
                .unwrap()
                .unwrap()
                .0
                .into_scalar()
                .unwrap()
                .as_str(),
            Some("Unsigned title")
        );
        assert_eq!(
            admitted
                .get(ROOT, "title")
                .unwrap()
                .unwrap()
                .0
                .into_scalar()
                .unwrap()
                .as_str(),
            Some("Trusted title")
        );
        assert_eq!(admission.verified_authorizations.len(), 1);
        assert!(
            admission.decisions.iter().any(|decision| matches!(
                decision.status,
                CausalAdmissionStatus::Quarantined { .. }
            ))
        );

        let completion =
            verify_revocation_completion(&candidate, &proof, &owner.person_id, "service", 0)
                .unwrap();
        assert_eq!(completion.workspace_id, "board");
        assert_eq!(completion.revocation_epoch, 4);
        assert_eq!(completion.revoked_person_id, "service");
        assert!(
            verify_revocation_completion(&candidate, &proof, "foreign-owner", "service", 0)
                .is_err()
        );
        let mut forged = proof.clone();
        forged["authority"]["revocations"][0]["signature"] = json!("forged");
        assert!(
            verify_revocation_completion(&candidate, &forged, &owner.person_id, "service", 0)
                .is_err()
        );
    }
}
