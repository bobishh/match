## Context and evidence

Baseline reviewed 2026-10-08 against working-tree files, including ongoing Keeper naming changes. The table below describes the pre-implementation baseline. Current implementation evidence is in `implementation.md`.

| Evidence | Current behavior |
| --- | --- |
| `../mesh-lighthouse/src/main.rs` intake loop | HTTP classification results create chat messages and lead cards in the primary store |
| `../mesh-lighthouse/src/lib.rs::create_lead` | Loads plaintext Automerge, requires Editor, writes item/placement/field values, signs change hashes |
| `../mesh-lighthouse/src/keeper.rs` | Loads and merges plaintext Automerge snapshots |
| `src/domain/permissions.ts` | Workspace Owner/Editor/Visitor roles; no relay-only content capability |
| `src/sync/changeAuthorization.ts` | Existing signed change admission and durable authority; reuse rather than bypass |
| `src/sync/keeperCommitReceipt.ts` | Existing receipt binds plaintext snapshot hash; needs separately negotiated ciphertext semantics |
| `vendor/meta-mesh/crates/meta-mesh/Cargo.toml`, `src/node.rs` | Browser transport depends on `iroh-webrtc-transport` with browser feature |
| `vendor/meta-mesh/vendor/iroh-webrtc-transport/src/browser/capabilities.rs` | Probes `RTCPeerConnection`; browser transport is not automatically a workerd transport |
| `docs/architecture.md` | Policy WASM already separated from browser transport; local commits persist document and authorizations atomically |

Prior chats: “Спроектировать почтовые карточки и R” proposed Worker → Clef → Keeper command API, No corresponding Worker/Clef implementation or email OpenSpec change was found in the inspected repositories. “Разделение Keeper и Clef” proposed blind storage and document-scoped execution. The earlier plaintext command API belongs to automation, not blind Keeper.

The existing `lighthouse-integrations` design explicitly describes trusted replication and Editor grants for Rusty. Treat that as the legacy contract, not proof of encrypted storage. This proposal changes the negotiated contract; existing working-tree changes stay untouched.

## Goals / non-goals

Goals: prove blind persistence across restart and two clients; create and move existing job-search cards while human clients are closed; keep automation access explicit and restricted; preserve author evidence through untrusted forwarding; migrate explicitly.

Non-goals: universal workflow platform, CAD execution, payment processing, arbitrary column-level secrecy inside one Automerge document, full mailbox OAuth in the first release, moving frontend hosting, choosing production cryptography without cross-runtime validation, or guaranteeing erasure of old plaintext copies.

## Decisions

### 1. Roles represent capabilities, not implicit trust

| Participant | Content access | Writes | Own durable state |
| --- | --- | --- | --- |
| Blind Keeper | No document/chat/blob plaintext or content keys | Opaque object storage and storage receipts only | Ciphertext, bounded routing metadata, relay policy |
| Automation peer | Only explicitly delegated documents and inbound payloads | Delegated signed commands in approved workspace/board | Execution ledger, limited keys, exact pending envelopes |
| Client peer | Granted documents | Existing authorized commands | Local documents, keys, proofs, pending ciphertext |

Keeper retains its own identity signing key to authenticate discovery/receipts. That key cannot author accepted application changes. It receives a dedicated relay/storage authorization, never the owner root or a readable Visitor/Editor invitation. Storage, read, write and authority-management permissions remain distinct.

Iroh connectivity relay and durable Keeper storage are separate responsibilities. This change does not turn Keeper into a new NAT traversal server. Keeper may expose both Iroh and HTTPS adapters for the same opaque storage protocol.

### 2. Encryption encloses application semantics

Introduce independent per-document content keys and monotonic key epochs, provisioned only to approved readers/writers. Never derive a public routing identifier directly into a content key. Use authenticated encryption; finalize primitive, nonce construction and key wrapping in the crypto spike with shared native/WASM test vectors. Do not design a new delegation framework merely to introduce Macaroons/UCAN names.

Implemented protocol 2 objects contain exactly `version`, opaque `scopeId`, `keyEpoch`, random `nonce` and `ciphertext`. AES-GCM associated data binds the `RUSTY/2/object` domain, scope and epoch; immutable object IDs hash canonical wire JSON. Storage bearer authorization is separate from application authorship. Author certificates and signed change proofs remain inside the encrypted snapshot, and receivers verify them before projection. Rusty signs durable receipts for ciphertext objects; there is no outer application-author signature or claim that Rusty authenticates card commands.

Keeper checks outer integrity, authorized upload/download policy, size and quota. It cannot validate card mutators, plaintext change hashes or complete Automerge heads and must not claim it does. Authentic but semantically unauthorized objects may be durably stored; clients must still reject them.

Use immutable encrypted objects plus a bounded paginated inventory to synchronize missing objects. Blind Keeper does not call Automerge sync/merge on ciphertext. Clients decrypt, validate dependencies and merge. Incomplete dependencies stay pending; forged/unauthorized objects never enter the visible document. Snapshots need authenticated history/provenance sufficient for current receiver admission; they are not a shortcut around author validation.

Encrypt chat content and attachments too. Blob IDs on Keeper reference ciphertext hashes; plaintext hashes, filenames, thumbnails and design content stay inside encrypted references. Public preview URLs are an explicit publication action, not default storage.

Visible leakage: opaque identifiers, public signing/policy evidence, sizes, timing, connection metadata and key epochs. No claim of traffic-analysis resistance. Automation and hosted Clef see the selected plaintext passed to inference; disclose this independently from Keeper blindness.

### 3. Automation writes the existing board under explicit delegation

The requested product is existing-board automation: website intake creates Lead cards; email moves the same cards to Interview/Rejected. A separate machine-card document alone would not satisfy it. No linked-document projection is required for v1.

Current entities share a workspace document. A key for that document exposes its whole plaintext; a token naming a column does not provide column-level secrecy. Approval must explicitly disclose this document read access and the selected data sent to hosted inference. Owners needing narrower confidentiality must isolate the job-search board in a separate workspace/document before provisioning; do not claim selective board reads inside a multi-board document.

Extend existing signed authority with an owner-signed automation command grant bound to integration, automation person/device, exact workspace/board IDs, policy revision, allowed command kinds, allowed target columns/fields and expiration/revocation generation. This is a new authority capability, not the existing broad Editor grant. A storage grant never supplies it. Do not introduce an unrestricted Editor intermediate mode and describe it as restricted.

Current implementation limits effects to `createItem` in configured Lead with approved fields and `moveEntity` of an eligible existing leaf card to configured Interview/Rejected. Existing-card source-note updates and automation chat authorship are later work. No ownership/access mutation, board/column/schema configuration, arbitrary card deletion, restore/archive, unrelated field edits or cross-board moves. Preserve existing command validation, timestamps, rank calculations and author proof format. Ranking may renumber siblings: explicitly validate those derived rank-only effects within the approved board, rather than trusting metadata that says “move”. Restrict v1 email moves to leaf cards to avoid unexpected descendant moves.

Expiration gates current automation execution and access, not historical admission against the receiver's current clock. A valid signed offline change has no trustworthy authoring-time proof; expiration alone cannot reject previously unseen changes without also erasing valid historical writes. Epoch/revocation evidence supplies receiver-enforced authority cutoff. Do not treat author wall-clock timestamps as evidence of pre-expiry authorship. Concurrent human and automation placement conflicts quarantine the automation branch and preserve the human projection.

Validate semantic before/after effects from the proven causal base against the delegated command; metadata alone is insufficient. Every receiver performs this check even if the Worker or Keeper says approved. Malicious signed changes labelled `moveEntity` but changing title, grant or another board must be rejected. Missing base/evidence stays pending. Shared validation belongs in transport-free policy; avoid a second permission implementation unique to the Worker.

Worker identity signs its own changes; owner credentials never sign on its behalf. Revoking automation leaves Keeper storage available. Requests/results can later use separate documents for CAD or narrower confidentiality, but that is not required for this website/email release.

### 4. Worker + Clef is feasible; prove the actual WASM boundary

Cloudflare Clef is a decision model, not a cryptographic peer or signing identity. The Worker automation service owns the device identity, validates payloads, calls `@cf/cloudflare/clef-flash`, checks decisions and signs changes. Clef receives a bounded state and typed choice questions; store model/schema version and all returned probabilities alongside the resulting decision in encrypted output. Confidence thresholds require a labeled sample evaluation; no invented accuracy guarantees.

Workers use workerd/V8 with partial Node compatibility, not a normal Node process. Rust Workers compile to WASM. The browser already proves that MetaMesh can execute as WASM; the unresolved question is host API compatibility, not whether Rust can run on Workers. Reuse transport-free policy and Automerge; build a Worker entry point without DOM, IndexedDB or WebRTC requirements.

Preferred path:

```text
website / forwarded email
  → Worker durable intake → Clef-flash decision
  → delegated existing-board command + signed proof
  → AEAD encrypted immutable envelope
  → HTTPS blind Keeper storage + durable receipt
  → authorized browser decrypts, validates, displays created/moved card
```

A durable coordinator per writable workspace document serializes automation mutations and persists Automerge state, proofs, event receipts and outbox. Queue delivery is at least once; consumer duplicates are expected. Native automation peer is a fallback only if a measured workerd packaging/runtime blocker remains after the transport-free spike. In that fallback Worker hands off authenticated durable events to a separate trusted peer; Keeper remains blind. Record concrete failure evidence before changing target.

HTTPS transport is a proposed new MetaMesh adapter with the same signed/encrypted object contract as other adapters. No plaintext-to-Keeper API. Optional WebSocket inventory notifications improve latency but correctness depends on durable pull and replay, not a persistent socket.

### 5. Preserve existing website intake; add email as another source

Current website behavior in `../mesh-lighthouse/src/http.rs`:

1. `GET /challenge` and `POST /ingest` validate bounded form fields and a short-lived single-use human check. Acceptance returns `202 pending` only after durable inbox save. Existing form fields: `message`, `contact`, `company`, `role`, `jobUrl`, human-check token/answer.
2. `fetch_job_page` performs bounded public-page fetching with redirect/time/size limits; `extract_job_page` reads JobPosting JSON-LD, OpenGraph and title, honoring explicitly supplied company/role.
3. Jev answers `job_opportunity` (yes/no/uncertain), `role_type` and `seniority`; distributions survive in `ProcessingResult`. The current create rule requires yes plus company, role and valid job URL; it has no additional confidence threshold.
4. A saved result waits in `awaiting_mesh` until the writer is available. Every classified intake produces chat evidence. Relevant complete inputs additionally call `create_lead`, using preset `status.lead` and company/role/url bindings. Terminal states are `chat_queued` or `card_created_v2`.

Port these responsibilities into automation, replace inference with `env.AI.run("@cf/cloudflare/clef-flash", ...)`, and preserve question meanings and probabilities. Cloudflare documents System One compatibility; validate actual response against existing assessment fixtures rather than assume a byte-identical SDK response. Record both model and question/policy revision. Keep inference output separate from permission checks. Preserve current creation behavior; any stricter confidence rule requires an explicit versioned policy, not an incidental model migration.

Maintain form API/response compatibility during cutover, updating frontend destination through existing intake configuration. Preserve anti-abuse semantics; replacement human-check provider is not part of this proposal. Do not port native DNS/reqwest calls literally to workerd: implement equivalent bounded public fetch/redirect validation using Worker APIs, and prove private-address/redirect rejection in adapter tests. Missing/blocked page fallback must retain supplied fields and leave insufficient inputs in chat/review rather than invent them.

Email first release uses a per-integration forwarding address on a configured domain. Cloudflare Email Routing hands incoming mail to automation; direct Gmail/Outlook OAuth sync is later. Address mapping selects integration/workspace; sender-supplied board IDs cannot select another target. Mailbox forwarding confirmation goes to a visible integration inbox, never a hidden automatic authorization action. MIME parsing, body and attachment limits preserve original source evidence; source mail is untrusted data.

Normalize `eventId`, mailbox/source, Message-ID/thread references, sender/recipient, subject, received time, bounded text and attachments. Message-ID is one correlation signal, not authenticated sender proof. Match an existing application using persisted thread binding, exact application/reference ID, normalized job URL or company+role plus verified context. Company alone is insufficient; multiple matches require review. A forwarded refusal does not create a new Lead simply because Clef calls it recruiting-related.

Add a separate typed `application_event` decision: new_opportunity, interview, rejected, offer, follow_up, unrelated, uncertain. Reuse role/seniority questions only for genuinely new leads. Store full probabilities, evidence excerpts and linked card ID. Threshold/margin for automatic status movement is owner-configured and evaluated on labeled examples; ambiguous decisions remain reviewable.

For an unambiguously linked high-confidence interview/refusal, append source evidence and execute `moveEntity` against that board's current `status.interview` / `status.rejected` binding in one logical durable operation. Use actual entity IDs; renamed columns keep working. Missing/deleted/mismatched bindings pause the action visibly. Rejected is a status column, not an archive command. Attachments and notes must retain source context; a classification does not overwrite the card's human-authored narrative.

Bind automatic transition to expected placement/status revision and causal frontier. A later email may transition Rejected → Interview if policy allows and newer evidence establishes it; no fixed numerical status ordering. An old forwarded message cannot roll back newer evidence. Source timestamps are hints and cannot establish causal precedence on their own. Conflict with a manual move or concurrent disconnected branch goes to review/reconciliation instead of silently selecting the automation write. Receiver projection/admission must preserve this rule when branches meet, not merely check once at Worker execution time.

Default workflow: clear matched events move automatically after explicit integration approval; uncertain correlation/classification or conflicting state asks for review. Journal shows received, classified, awaiting_sync, needs_review, applied, failed and revoked; successful application links to actual card/history. Restoring a prior status is a new authorized command, not deletion of audit evidence.

### 6. Reliable events and concurrency

Use namespaced stable `eventId` from provider event ID or persisted ingress receipt; a content digest alone must not collapse distinct identical submissions. Stable `jobId` identifies the logical action; `attemptId` identifies retries; card ID derives from integration + event + action. Pin decision/policy version and exact prepared encrypted envelopes durably before publication.

Atomically persist local Automerge changes, proofs, event result and pending outbox before upload. After a crash or lost Keeper response, retry identical envelope bytes/object ID, never re-author another change for the same event. A Keeper receipt confirms remote ciphertext persistence; local command completion confirms local authoring. Queue acknowledgement follows durable local commit with retryable outbox, or complete remote publication according to the chosen delivery contract; document which guarantee the response represents.

Same IDs do not solve concurrent creation of conflicting nested Automerge maps. V1 has one authoritative durable execution coordinator per writable workspace document; competing consumers submit to it. Assignment changes require fencing generations. Different workspace documents remain independently processable; multiple sources targeting one workspace share its coordinator. Test multiple consumers, restart and lost-response windows.

Human and automation writes to the same board need explicit conflict semantics. Do not rebuild existing placement/rank model into append-only arrays. For email status changes, bind proposals to target card, source event time and expected prior status/frontier; stale/ambiguous proposals enter review. Company name alone cannot identify an application.

For external side effects, CRDT job claims are not exclusive locks. V1 creates cards and moves statuses; later CAD/payment work needs provider idempotency plus leased/fenced execution or an explicit duplicate-tolerant policy.

### 7. Pairing, durability and revocation

Discovery advertises separate versioned blind-storage and automation capabilities. Mutual approval binds exact document IDs, mode, pinned service identity, revisions and expiration. Blind storage approval never implicitly authorizes automation. Legacy trusted services cannot be silently relabeled blind.

Durable storage receipt signs Keeper identity/device, request nonce, integration/scope/document ID, key epoch, exact ciphertext object hashes, policy revision and durable commit identifier. Emit only after the configured durable store transaction/fsync completes. Browser independently knows which ciphertext objects cover its local plaintext frontier and missing attachments. Display “Encrypted objects saved” separately from content verified/merged and from attachment completion. Receipt proves an accountable storage assertion, not mathematical future availability or semantic validity.

Revocation uses monotonic signed authority generations at each receiver; stale epochs do not regain rights via another relay. Rotate keys for future confidential content and redistribute only to remaining authorized identities. Old readers retain old keys/content; cryptographic revocation cannot erase history. Delayed changes whose timing/order cannot be established under the revoked generation remain quarantined pending authorized reconciliation; do not trust author wall-clock timestamps to restore them. Exact cutoff and offline branch policy must be specified and tested before release.

### 8. Migration and responsibility

Keep legacy plaintext service explicitly “Trusted replica” during rollout. Blind mode uses separate storage namespace and never imports plaintext directly at Keeper. An authorized client validates/decrypts old history locally, uploads encrypted history/chat/blobs, verifies durable coverage and another client's restart recovery, then revokes old Keeper Editor grants and disconnects legacy automation. No automatic fallback to plaintext. Warn that old host copies/backups cannot be proven erased.

Move website extraction, Jev/Clef calls, raw inbox and lead/chat authorship out of blind Keeper startup. Do not delete queued intake: transfer events to the automation ledger preserving original event/card IDs and test replay. Support mixed version clients only through explicit protocol negotiation; never transmit a blind document in cleartext to an old client.

MetaMesh owns cryptographic envelopes, document access/key epochs, transport-independent validation and adapters. tincanban owns existing-board card commands and status bindings, approval/status UI and schema validation. Standalone Keeper owns opaque persistence, quotas, inventory and receipts. Automation service owns ingestion, classification and execution state. Test the actual standalone service as well as adapters.

## Research sources and remaining gates

Official sources checked 2026-10-08:

- [Clef announcement and System One compatibility](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/) and [Clef-flash model](https://developers.cloudflare.com/workers-ai/models/clef-flash/): available via Workers AI; validate actual binding response in a smoke run.
- [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [WASM](https://developers.cloudflare.com/workers/runtime-apis/webassembly/), [TCP socket boundaries](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): partial host compatibility does not supply browser WebRTC or a native runtime.
- [Email Routing to Workers](https://developers.cloudflare.com/email-routing/email-workers/) establishes the forwarded-email input; provider/domain configuration is a rollout prerequisite.
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/): durable coordinator and replay-safe outbox are appropriate, but exact workload budgets need measurements.
- [Automerge ARK guide](https://automerge.org/docs/keyhive/ark-api-guide/): alpha, document Relay/Read/Edit/Admin access, ciphertext relay. Evaluate native/browser interoperability and identity/provenance mapping before adopting; not a drop-in replacement for pinned MetaMesh.

Remaining gates: review the implemented AES-GCM envelope/key layer, prove policy/Automerge packaging and delegated existing-board/email writes in workerd, test authority cutoffs across receivers and execute live Clef inference. Earlier experiment stopped at a deliberate 501; the current full implementation has superseded that experiment. Current evidence belongs in `implementation.md`; source presence alone does not establish runtime compatibility. No free-cost promise; measure storage, inference, retries and coordinator usage.
