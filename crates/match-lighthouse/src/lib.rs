use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use automerge::AutoCommit;
use match_authority::{admit_match_candidate, prepare_match_write_authority};
use meta_mesh_core::{MeshHandshake, MeshPeerAdmission, WorkspaceWriteAuthorizationSnapshot};
use meta_mesh_native::{
    FileScopeStore, NativeScopeCredential, NativeScopeHost, NativeScopeServiceHost,
    NativeScopeSnapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLighthouseState {
    pub document: Vec<u8>,
    pub authorization: Value,
    #[serde(default = "empty_chat")]
    pub chat: Value,
}

fn empty_chat() -> Value {
    json!({"version": 1, "messages": [], "profiles": [], "typing": []})
}

struct Inner {
    state: MatchLighthouseState,
    file: FileScopeStore,
}

#[derive(Clone)]
pub struct MatchScopeStore {
    workspace_id: String,
    genesis_person_id: String,
    inner: Arc<Mutex<Inner>>,
}

impl MatchScopeStore {
    pub fn open(
        workspace_id: String,
        genesis_person_id: String,
        path: PathBuf,
        initial: MatchLighthouseState,
    ) -> Result<Self, String> {
        let file = FileScopeStore::new(path);
        let state = match file.read()? {
            Some(bytes) => serde_json::from_slice::<MatchLighthouseState>(&bytes)
                .map_err(|error| format!("Invalid lighthouse state: {error}"))?,
            None => initial,
        };
        let store = Self {
            workspace_id,
            genesis_person_id,
            inner: Arc::new(Mutex::new(Inner { state, file })),
        };
        {
            let guard = store
                .inner
                .lock()
                .map_err(|_| "Lighthouse state lock poisoned")?;
            store.authority_for(&guard.state)?;
            let mut current = AutoCommit::load(&guard.state.document)
                .map_err(|error| format!("Invalid lighthouse document: {error}"))?;
            let hashes = current
                .get_changes(&[])
                .iter()
                .map(|change| change.hash().to_string())
                .collect::<Vec<_>>();
            let (snapshot, _) = store.authority_for(&guard.state)?;
            admit_match_candidate(
                None,
                &guard.state.document,
                &hashes,
                Some(&guard.state.authorization),
                snapshot,
                now_ms()?,
            )?;
            if guard.file.read()?.is_none() {
                write_state(&guard.file, &guard.state)?;
            }
        }
        Ok(store)
    }

    pub fn authority(&self) -> Result<WorkspaceWriteAuthorizationSnapshot, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Lighthouse state lock poisoned")?;
        self.authority_for(&guard.state)
            .map(|(snapshot, _)| snapshot)
    }

    fn authority_for(
        &self,
        state: &MatchLighthouseState,
    ) -> Result<(WorkspaceWriteAuthorizationSnapshot, Value), String> {
        let evidence = state
            .authorization
            .get("authority")
            .ok_or("Missing lighthouse authority")?;
        let records = state
            .authorization
            .get("records")
            .and_then(Value::as_array)
            .ok_or("Missing lighthouse write authorizations")?;
        let (snapshot, merged) = prepare_match_write_authority(
            &state.document,
            evidence,
            None,
            records,
            &self.genesis_person_id,
            now_ms()?,
        )?;
        if snapshot.workspace_id != self.workspace_id {
            return Err("Lighthouse workspace does not match document".into());
        }
        Ok((snapshot, merged))
    }

    fn save(&self, guard: &mut Inner, next: MatchLighthouseState) -> Result<(), String> {
        write_state(&guard.file, &next)?;
        guard.state = next;
        Ok(())
    }
}

impl NativeScopeHost for MatchScopeStore {
    fn snapshot(&mut self) -> Result<NativeScopeSnapshot, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Lighthouse state lock poisoned")?;
        Ok(NativeScopeSnapshot {
            document: guard.state.document.clone(),
            authorization: Some(guard.state.authorization.clone()),
            chat: Some(guard.state.chat.clone()),
            mesh: None,
        })
    }

    fn persist_document(
        &mut self,
        candidate: &[u8],
        proof: Option<&Value>,
        accepted_hashes: &[String],
    ) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Lighthouse state lock poisoned")?;
        let incoming = proof
            .and_then(|value| value.get("authority"))
            .ok_or("Missing incoming Match authority")?;
        let incoming_records = proof
            .and_then(|value| value.get("records"))
            .and_then(Value::as_array)
            .ok_or("Missing incoming Match write authorizations")?;
        let known = guard.state.authorization.get("authority");
        let (snapshot, merged) = prepare_match_write_authority(
            candidate,
            incoming,
            known,
            incoming_records,
            &self.genesis_person_id,
            now_ms()?,
        )?;
        let verified = admit_match_candidate(
            Some(&guard.state.document),
            candidate,
            accepted_hashes,
            proof,
            snapshot,
            now_ms()?,
        )?;
        let records = merge_records(
            guard
                .state
                .authorization
                .get("records")
                .and_then(Value::as_array),
            &verified,
        );
        let mut next = guard.state.clone();
        next.document = candidate.to_vec();
        next.authorization = json!({"version": 1, "records": records, "authority": merged});
        self.save(&mut guard, next)
    }

    fn merge_authorization(&mut self, incoming: &Value) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Lighthouse state lock poisoned")?;
        let incoming_evidence = incoming.get("authority").ok_or("Missing Match authority")?;
        let incoming_records = incoming
            .get("records")
            .and_then(Value::as_array)
            .ok_or("Missing Match write authorizations")?;
        let (snapshot, merged) = prepare_match_write_authority(
            &guard.state.document,
            incoming_evidence,
            guard.state.authorization.get("authority"),
            incoming_records,
            &self.genesis_person_id,
            now_ms()?,
        )?;
        let verified = admit_match_candidate(
            Some(&guard.state.document),
            &guard.state.document,
            &[],
            Some(incoming),
            snapshot,
            now_ms()?,
        )?;
        let records = merge_records(
            guard
                .state
                .authorization
                .get("records")
                .and_then(Value::as_array),
            &verified,
        );
        let mut next = guard.state.clone();
        next.authorization = json!({"version": 1, "records": records, "authority": merged});
        self.save(&mut guard, next)
    }

    fn merge_chat(&mut self, incoming: &Value) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Lighthouse state lock poisoned")?;
        let mut next = guard.state.clone();
        next.chat = merge_chat(&next.chat, incoming)?;
        self.save(&mut guard, next)
    }

    fn merge_mesh(&mut self, _: &Value) -> Result<(), String> {
        Err("Match lighthouse does not accept mesh metadata controls".into())
    }

    fn merge_durable_batch(&mut self, _: &[u8]) -> Result<(), String> {
        Err("Match lighthouse does not accept workspace-set imports".into())
    }

    fn merge_owner_offer(&mut self, _: &[u8]) -> Result<(), String> {
        Err("Match lighthouse does not accept owner workspace offers".into())
    }

    fn receive_gossip(&mut self, _: &[u8]) -> Result<(), String> {
        // Gossip is a wake-up hint; periodic anti-entropy owns document delivery.
        Ok(())
    }
}

pub struct MatchLighthouseHost {
    pub workspace_id: String,
    pub secret: String,
    pub local_device_id: String,
    pub local_handshake: MeshHandshake,
    pub store: MatchScopeStore,
}

impl NativeScopeServiceHost for MatchLighthouseHost {
    type ScopeHost = MatchScopeStore;

    fn local_device_id(&self) -> &str {
        &self.local_device_id
    }

    fn credential(&mut self, secret: &str) -> Result<Option<NativeScopeCredential>, String> {
        Ok((secret == self.secret).then(|| NativeScopeCredential {
            workspace_id: self.workspace_id.clone(),
            secret: self.secret.clone(),
        }))
    }

    fn prepare_handshake(
        &mut self,
        workspace_id: &str,
        _: &MeshHandshake,
    ) -> Result<(WorkspaceWriteAuthorizationSnapshot, Value), String> {
        if workspace_id != self.workspace_id {
            return Err("Wrong lighthouse workspace".into());
        }
        Ok((
            self.store.authority()?,
            serde_json::to_value(&self.local_handshake).map_err(|error| error.to_string())?,
        ))
    }

    fn authority(
        &mut self,
        workspace_id: &str,
    ) -> Result<WorkspaceWriteAuthorizationSnapshot, String> {
        if workspace_id != self.workspace_id {
            return Err("Wrong lighthouse workspace".into());
        }
        self.store.authority()
    }

    fn outgoing_handshake(&mut self, workspace_id: &str) -> Result<Value, String> {
        if workspace_id != self.workspace_id {
            return Err("Wrong lighthouse workspace".into());
        }
        serde_json::to_value(&self.local_handshake).map_err(|error| error.to_string())
    }

    fn open_scope(&mut self, peer: &MeshPeerAdmission) -> Result<Self::ScopeHost, String> {
        if peer.workspace_id != self.workspace_id {
            return Err("Wrong lighthouse workspace".into());
        }
        Ok(self.store.clone())
    }
}

fn write_state(file: &FileScopeStore, state: &MatchLighthouseState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    file.write_validated(&bytes, None, |_, _| Ok(()))
}

fn merge_records(existing: Option<&Vec<Value>>, incoming: &[Value]) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    existing
        .into_iter()
        .flatten()
        .chain(incoming)
        .filter(|record| seen.insert(record.to_string()))
        .cloned()
        .collect()
}

fn merge_chat(current: &Value, incoming: &Value) -> Result<Value, String> {
    if incoming.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Invalid chat batch".into());
    }
    if serde_json::to_vec(incoming)
        .map_err(|error| error.to_string())?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("Invalid chat batch".into());
    }
    if incoming
        .get("typing")
        .is_some_and(|value| value.as_array().is_none_or(|items| items.len() > 512))
    {
        return Err("Invalid chat batch".into());
    }
    let mut result = serde_json::Map::new();
    for (field, limit) in [("messages", 20_000), ("profiles", 2_000)] {
        let old = current
            .get(field)
            .and_then(Value::as_array)
            .ok_or("Invalid stored chat")?;
        let new = incoming
            .get(field)
            .and_then(Value::as_array)
            .ok_or("Invalid chat batch")?;
        if new.len() > if field == "messages" { 2_000 } else { 512 } {
            return Err("Invalid chat batch".into());
        }
        let mut seen = BTreeSet::new();
        let values = old
            .iter()
            .chain(new)
            .filter(|record| {
                record
                    .pointer("/signed/signature")
                    .and_then(Value::as_str)
                    .is_some_and(|signature| !signature.is_empty())
            })
            .filter(|record| seen.insert(record.pointer("/signed/signature").unwrap().to_string()))
            .take(limit + 1)
            .cloned()
            .collect::<Vec<_>>();
        if values.len() > limit {
            return Err("Lighthouse chat storage limit exceeded".into());
        }
        result.insert(field.into(), Value::Array(values));
    }
    result.insert("version".into(), json!(1));
    result.insert("typing".into(), json!([]));
    Ok(Value::Object(result))
}

pub fn now_ms() -> Result<i128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as i128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{ROOT, transaction::Transactable};
    use meta_mesh_core::{
        DEFAULT_SIGNATURE_DOMAIN, DeviceCertificatePayload, WorkspaceAuthority,
        WorkspaceChangeAuthorizationPayload, public_key_from_seed, public_key_id,
        sign_device_certificate, sign_json_envelope,
    };

    #[test]
    fn signed_document_survives_restart_but_unsigned_change_never_replaces_it() {
        let public_key = public_key_from_seed(&[1; 32]).unwrap();
        let person_id = public_key_id(&public_key).unwrap();
        let device_public_key = public_key_from_seed(&[2; 32]).unwrap();
        let device_id = public_key_id(&device_public_key).unwrap();
        let certificate = sign_device_certificate(
            &[1; 32],
            DeviceCertificatePayload {
                kind: "device-certificate".into(),
                version: 1,
                person_id: person_id.clone(),
                device_id: device_id.clone(),
                device_public_key,
                issuer_certificate_hash: None,
                can_enroll_devices: true,
            },
            &person_id,
            DEFAULT_SIGNATURE_DOMAIN,
        )
        .unwrap();
        let owner = WorkspaceAuthority {
            person_id: person_id.clone(),
            public_key: public_key.clone(),
            certificates: vec![certificate.clone()],
        };
        let evidence = json!({
            "genesisOwner": owner, "genesisEpoch": 1,
            "currentOwner": owner, "currentEpoch": 1,
            "ownershipTransfers": [], "successionClaims": [],
            "revocations": [], "deviceRevocations": [], "departures": [],
        });
        let proof_for = |hashes: Vec<String>| {
            let signed = sign_json_envelope(
                &[2; 32],
                json!(WorkspaceChangeAuthorizationPayload {
                    kind: "workspace-changes".into(),
                    version: 1,
                    workspace_id: "board".into(),
                    hashes,
                    person_id: person_id.clone(),
                    device_id: device_id.clone(),
                }),
                &device_id,
                DEFAULT_SIGNATURE_DOMAIN,
            )
            .unwrap();
            json!({"version": 1, "records": [{
                "signed": signed, "publicKey": public_key, "certificates": [certificate]
            }], "authority": evidence})
        };
        let mut document = AutoCommit::new();
        document.put(ROOT, "id", "board").unwrap();
        document
            .put(ROOT, "ownerPersonId", person_id.clone())
            .unwrap();
        document.put(ROOT, "title", "Original").unwrap();
        document
            .put_object(ROOT, "entities", automerge::ObjType::Map)
            .unwrap();
        let baseline = document.save();
        let initial_hashes = document
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().to_string())
            .collect();
        let initial = MatchLighthouseState {
            document: baseline.clone(),
            authorization: proof_for(initial_hashes),
            chat: empty_chat(),
        };
        let path = std::env::temp_dir().join(format!(
            "match-lighthouse-{}-{}.json",
            std::process::id(),
            now_ms().unwrap()
        ));
        let mut store = MatchScopeStore::open(
            "board".into(),
            person_id.clone(),
            path.clone(),
            initial.clone(),
        )
        .unwrap();
        document.put(ROOT, "title", "Updated").unwrap();
        let candidate = document.save();
        let new_hash = document.get_heads()[0].to_string();
        assert!(
            store
                .persist_document(
                    &candidate,
                    Some(&json!({
                        "version": 1, "records": [], "authority": evidence,
                    })),
                    &[new_hash.clone()]
                )
                .is_err()
        );
        assert_eq!(store.snapshot().unwrap().document, baseline);
        store
            .persist_document(
                &candidate,
                Some(&proof_for(vec![new_hash])),
                &[document.get_heads()[0].to_string()],
            )
            .unwrap();
        assert!(
            store
                .persist_document(&baseline, Some(&initial.authorization), &[])
                .is_err()
        );
        assert_eq!(store.snapshot().unwrap().document, candidate);
        let mut reopened =
            MatchScopeStore::open("board".into(), person_id, path.clone(), initial).unwrap();
        assert_eq!(reopened.snapshot().unwrap().document, candidate);
        std::fs::remove_file(path).unwrap();
    }
}
