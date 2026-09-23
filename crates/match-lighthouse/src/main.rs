use std::{fs, path::PathBuf, str::FromStr, sync::Arc, time::Duration};

use iroh::{EndpointAddr, EndpointId};
use match_lighthouse::{MatchLighthouseHost, MatchLighthouseState, MatchScopeStore, now_ms};
use meta_mesh_core::{
    MeshHandshake, VerifyWorkspaceMemberOptions, WorkspaceRole, verify_workspace_member_bundle,
};
use meta_mesh_native::{
    NativeBrowserConnection, NativeNode, NativeNodeOptions, NativeScopeService, publish_scope_to,
    serve_scope_connection, serve_scope_request,
};
use serde::Deserialize;
use tokio::sync::Mutex;

mod join;

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    workspace_id: String,
    transport_secret: String,
    device_id: String,
    iroh_secret: Vec<u8>,
    owner_endpoint_id: String,
    local_handshake: MeshHandshake,
    genesis_person_id: String,
    state_path: PathBuf,
    initial_state: MatchLighthouseState,
    #[serde(default)]
    identity_seed: Vec<u8>,
    #[serde(default)]
    device_seed: Vec<u8>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or(
        "Usage: match-lighthouse CONFIG.json | match-lighthouse join INVITE_URL STATE_DIR",
    )?;
    if path == "join" {
        let invite = args
            .next()
            .ok_or("Missing Match workspace invitation URL")?;
        let directory = args.next().ok_or("Missing lighthouse state directory")?;
        if args.next().is_some() {
            return Err("Too many join arguments".into());
        }
        join::join(&invite, PathBuf::from(directory)).await?;
        return Ok(());
    }
    if args.next().is_some() {
        return Err("Too many arguments".into());
    }
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
    let mut browser: Option<Arc<NativeBrowserConnection>> = None;
    let mut receiver: Option<tokio::task::JoinHandle<Result<(), String>>> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        if receiver.as_ref().is_some_and(|task| task.is_finished()) {
            if let Some(task) = receiver.take() {
                if let Ok(Err(error)) = task.await {
                    eprintln!("Lighthouse receive: {error}");
                }
            }
            if let Some(connection) = browser.take() {
                connection.close();
            }
            service
                .lock()
                .await
                .forget_peer(&config.workspace_id, &owner_id.to_string());
        }
        if browser.is_none() {
            let connection = match node
                .connect_browser(owner.clone(), Duration::from_secs(12))
                .await
            {
                Ok(connection) => Arc::new(connection),
                Err(error) => {
                    eprintln!("Lighthouse connect: {error}");
                    continue;
                }
            };
            let request = service
                .lock()
                .await
                .prepare_connect(&config.workspace_id, &config.transport_secret)?;
            match connection.exchange(&request, Duration::from_secs(12)).await {
                Ok(response) => {
                    let peer = service.lock().await.complete_connect(
                        &config.workspace_id,
                        &config.transport_secret,
                        &owner_id.to_string(),
                        &response,
                        now_ms()?,
                    );
                    match peer {
                        Ok(peer) if peer.role == WorkspaceRole::Owner => {
                            let incoming_connection = Arc::clone(&connection);
                            let incoming_service = Arc::clone(&service);
                            let remote_id = owner_id.to_string();
                            receiver = Some(tokio::spawn(async move {
                                serve_scope_connection(
                                    &incoming_connection,
                                    &incoming_service,
                                    &remote_id,
                                    || now_ms().map_err(|error| error.to_string()),
                                )
                                .await
                            }));
                            browser = Some(connection);
                        }
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
        let connection = browser.as_ref().expect("connected above");
        match publish_scope_to(
            connection,
            &service,
            &config.workspace_id,
            &owner_id.to_string(),
            now_ms()?,
            Duration::from_secs(12),
        )
        .await
        {
            Ok(()) => {}
            Err(error) if error == "Unauthenticated mesh peer" => {}
            Err(error) => {
                eprintln!("Lighthouse publish: {error}");
                connection.close();
                browser = None;
                if let Some(task) = receiver.take() {
                    task.abort();
                }
                service
                    .lock()
                    .await
                    .forget_peer(&config.workspace_id, &owner_id.to_string());
            }
        }
    }
}
