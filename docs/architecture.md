# Match architecture

Match is a local-first board application. Its data model and authorization are
application concerns; shared networking and cryptographic primitives live in
[MetaMesh](https://github.com/bobishh/meta-mesh).

## Boundaries

| Area | Responsibility | Must not substitute for |
| --- | --- | --- |
| Vue components | Presentation, drafts, user events | Authorization or durable storage |
| Application modules (`src/app`) | Compose board, access, chat, and lifecycle operations | A public bag of every state field |
| Domain commands (`src/domain`) | Validate and apply board changes | Transport or peer discovery |
| State/persistence | Serialize local mutations and publish committed state | Permission checks based only on visible buttons |
| Authorization (`src/sync/changeAuthorization.ts`) | Validate local roles and signed incoming changes | Automerge merge semantics |
| Workspace replication (`src/sync`) | Connect Match documents and proofs to mesh sessions | Generic product-independent domain rules |
| MetaMesh | Identity, protocol framing, transport, shared runtime state machines | Match's card/board UI |

Automerge records concurrent changes. IndexedDB persists snapshots and public
proofs. Live sync exchanges missing document changes; attachments use a separate
content-addressed transfer. Same-device tabs refresh committed state through
browser notifications rather than pretending each tab is a different user.

## Startup is not transport startup

The current browser artifact bundles Rust policy code and transport bindings.
Match must initialize that WASM module before reading state that calls Rust policy
functions. It then hydrates local documents. Starting an Iroh node and connecting
to peers happens afterwards.

Therefore **local-first is not lazy-loading all of Iroh**. A failed WASM download
can prevent opening local data; a failed peer connection should not. Startup errors
must identify which stage failed instead of suggesting that stored data is corrupt.
Splitting policy WASM from transport is future packaging work, not something fixed
by moving `hydrate()` above initialization.

## Identity and access

A person owns workspaces. Devices have individual signing keys and certificates.
Enrollment authorizes another device for the same identity without copying the
root private key. Both devices should have the same ordinary workspace rights.
Some recovery paths still depend on the root key; this is a known limitation, not
a deliberate primary-device product role.

A workspace invitation gives another person a scoped role. Owner authority,
transfer history, grants, and revocations persist separately from disposable
connection routes. Do not infer owner rights merely from an imported document's
owner ID. Local creation must establish its authority as part of the application
flow, including a replacement board after the last workspace is deleted.

MetaMesh recovery words wrap a random root key in an encrypted envelope. They do
not independently reconstruct it. Match does not yet provide a complete backup,
recovery-envelope export, key rotation, or stolen-device recovery flow.

## Connection protocol

A session authenticates its remote identity and negotiates capabilities. Owner
workspace offers use `mesh-owner-workspace-offer` / `owner-workspace-v2` and are
sent only to a supported same-person session. `mesh-iroh-gossip` carries actual
Iroh gossip packets. These are different messages and have different receivers.
Logs associate session closure and receive failures with a connection, workspace,
and browser instance. One device may have multiple workspace/instance sessions;
a temporary session replacement is not proof of a whole-device network outage.

## Remaining compromises

- The browser runtime and application still share some lifecycle and workspace
  orchestration. A complete product-independent runtime extraction is unfinished.
- Trusted-group succession handles conflicts by pausing writes; it is not a
  Byzantine consensus or stolen-device recovery mechanism.
- There is no permanent hosted replica or account service. Discovery/relay
  infrastructure is still used for connectivity.
- Framework/component tests and browser regressions exercise behavior, but do not
  constitute an independent cryptographic audit.

For a short demonstration, use [the demo guide](demo.md). For the full current
feature/tool catalog, see [the protocol reference](protocol-and-tools.md).
