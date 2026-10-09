## Why

The current Keeper combines durable replication, plaintext document access, website intake, classification and card authorship. Storage availability therefore requires trusting its host with board content and Editor authority. Separate encrypted storage from explicitly authorized automation before extending website/email workflows with Cloudflare Clef.

## What Changes

- Introduce a blind Keeper role that stores and forwards encrypted document changes, snapshots, chat and attachments without content keys or application write grants.
- Introduce an independent automation identity with owner-approved access to exact documents; Cloudflare Worker + Clef-flash is the preferred first execution target.
- Prove transport-free policy/Automerge WASM in workerd and use a versioned HTTPS ciphertext transport rather than require the browser WebRTC or native Iroh runtime inside Workers.
- Move the existing website lead pipeline out of Keeper into Worker + Clef: bounded page extraction, relevance/role/seniority decisions, chat evidence and signed Lead creation in the existing board.
- Add forwarded-email intake that correlates a specific application and creates cards or moves existing cards to Interview/Rejected while all human clients are closed.
- Give the independent automation peer explicit document read access and narrowly delegated card/note/chat commands, enforced again by every receiver. No owner root, access management or implicit Keeper rights.
- Add durable event identity, replay-safe publication, review states and conflict handling for website intake, then forwarded email.
- **BREAKING:** Blind protocol admission is distinct from legacy Visitor/Editor invitations. A Visitor grant is readable and cannot mean blind storage; old services remain explicitly trusted until migrated.
- Supersede the pending `lighthouse-integrations` assumption that every Keeper needs Editor rights for Rusty. Preserve its mutual approval, identity pinning and durable acknowledgement requirements.

## Capabilities

### New Capabilities

- `blind-keeper`: Encrypted store-and-forward, relay-only authorization, exact durable receipts and explicit legacy migration.
- `scoped-automation`: Independent execution identity, restricted board commands, durable execution and receiver-enforced authorization.
- `lead-and-email-ingestion`: Preserve website intake with Clef and add correlated email-driven card creation and Interview/Rejected transitions.

### Modified Capabilities

None in archived main specs. `keeper-integrations` is a pending change, not a main spec; this change supersedes its Editor-only storage policy for negotiated blind mode, without rewriting its existing files.

## Impact

- tincanban: `src/sync/keeperDiscovery.ts`, `keeperPairing.ts`, `keeperCommitReceipt.ts`, `changeAuthorization.ts`, workspace admission/storage, existing-board card creation/status transitions and integration UI.
- MetaMesh: transport-free policy, content-key distribution, encrypted envelopes, document grants, receiver admission, HTTP transport adapter and shared browser/native fixtures.
- Standalone `../mesh-lighthouse`: split `src/main.rs`, `http.rs`, `lib.rs`, `keeper.rs`, provisioning and replication into storage and automation responsibilities. In-tree `crates/tincanban-lighthouse` remains a separate test adapter.
- Cloudflare: Worker, Workers AI, durable per-integration execution state and encrypted object publication. No deployment, frontend-hosting migration or runtime implementation is part of authoring this proposal.
