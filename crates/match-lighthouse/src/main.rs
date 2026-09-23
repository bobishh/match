use std::{fs, path::PathBuf, str::FromStr, sync::Arc, time::Duration};

use iroh::{EndpointAddr, EndpointId};
use match_lighthouse::{MatchLighthouseHost, MatchLighthouseState, MatchScopeStore, now_ms};
use meta_mesh_core::{
    MeshHandshake, VerifyWorkspaceMemberOptions, WorkspaceRole, verify_workspace_member_bundle,
};
use meta_mesh_native::{
    NativeNode, NativeNodeOptions, NativeScopeService, publish_scope_to, serve_scope_request,
};
use serde::Deserialize;
use tokio::sync::Mutex;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    workspace_id: String,
    transport_secret: String,
    device_id: String,
    iroh_secret: Vec<u8>,
    owner_endpoint_id: String,
    local_handshake: MeshHandshake,
    genesis_person_id: String,
    state_path: PathBuf,
    initial_state: MatchLighthouseState,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Usage: match-lighthouse CONFIG.json")?;
    let config: Config = serde_json::from_slice(&fs::read(path)?)?;
    let secret: [u8; 32] = config
        .iroh_secret
        .as_slice()
        .try_into()
        .map_err(|_| "Lighthouse Iroh secret must contain 32 bytes")?;
    let owner_id = EndpointId::from_str(&config.owner_endpoint_id)?;
    let node = Arc::new(
        NativeNode::start_with_options(NativeNodeOptions {
            secret: Some(secret),
            allowed_peers: vec![owner_id],
            ..NativeNodeOptions::default()
        })
        .await?,
    );
    if config.local_handshake.workspace_id != config.workspace_id {
        return Err("Lighthouse handshake targets another workspace".into());
    }
    let store = MatchScopeStore::open(
        config.workspace_id.clone(),
        config.genesis_person_id.clone(),
        config.state_path,
        config.initial_state,
    )?;
    let authority = store.authority()?;
    let verified = verify_workspace_member_bundle(
        config.local_handshake.peer.clone(),
        VerifyWorkspaceMemberOptions {
            workspace_id: Some(config.workspace_id.clone()),
            owner_person_id: Some(authority.expected_current_owner.person_id.clone()),
            owner_public_key: Some(authority.expected_current_owner.public_key.clone()),
            owner_certificates: authority.expected_current_owner.certificates.clone(),
            owner_history: vec![authority.genesis_owner.clone()],
            ..Default::default()
        },
        now_ms()?,
    )?;
    if verified.payload.device_id != config.device_id
        || verified.payload.endpoint != node.endpoint_id().to_string()
    {
        return Err("Lighthouse advertisement does not match Iroh endpoint".into());
    }
    let host = MatchLighthouseHost {
        workspace_id: config.workspace_id.clone(),
        secret: config.transport_secret.clone(),
        local_device_id: config.device_id,
        local_handshake: config.local_handshake,
        store,
    };
    let service = Arc::new(Mutex::new(NativeScopeService::new(host)));
    let incoming_node = Arc::clone(&node);
    let incoming_service = Arc::clone(&service);
    tokio::spawn(async move {
        loop {
            match serve_scope_request(&incoming_node, &incoming_service, now_ms().unwrap_or(0))
                .await
            {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => eprintln!("Lighthouse receive: {error}"),
            }
        }
    });
    println!(
        "Lighthouse {} listening for workspace {}",
        node.endpoint_id(),
        config.workspace_id
    );
    let owner = EndpointAddr::new(owner_id);
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        if !service
            .lock()
            .await
            .has_peer(&config.workspace_id, &owner_id.to_string())
        {
            let request = service
                .lock()
                .await
                .prepare_connect(&config.workspace_id, &config.transport_secret)?;
            match node
                .request(owner.clone(), &request, Duration::from_secs(12))
                .await
            {
                Ok(response) => {
                    let peer = service.lock().await.complete_connect(
                        &config.workspace_id,
                        &config.transport_secret,
                        &owner_id.to_string(),
                        &response,
                        now_ms()?,
                    );
                    match peer {
                        Ok(peer) if peer.role == WorkspaceRole::Owner => {}
                        Ok(_) => {
                            return Err(
                                "Configured lighthouse peer is not the workspace owner".into()
                            );
                        }
                        Err(error) => eprintln!("Lighthouse handshake: {error}"),
                    }
                }
                Err(error) => eprintln!("Lighthouse connect: {error}"),
            }
            continue;
        }
        match publish_scope_to(
            &node,
            &service,
            &config.workspace_id,
            owner.clone(),
            now_ms()?,
            Duration::from_secs(12),
        )
        .await
        {
            Ok(()) => {}
            Err(error) if error == "Unauthenticated mesh peer" => {}
            Err(error) => eprintln!("Lighthouse publish: {error}"),
        }
    }
}
