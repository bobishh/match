## 0. Delivered blind Rusty slice (2026-10-08)

- [x] 0.1 Replace standalone runtime with protocol 2 opaque storage; remove plaintext intake/authority modules and Jev/native-Iroh dependencies. Preserve pre-existing uncommitted old mesh source files outside the module graph.
- [x] 0.2 Add fresh-directory refusal, per-scope read/write credentials and revision/revocation, service identity pinning, durable signed receipts, quotas and exclusive process lock.
- [x] 0.3 Encrypt board history/proofs/chat in the browser; retain existing causal admission, persist cursor only after successful admission, reuse ciphertext after uncertain upload, and expose setup/private access/retry in Sync.
- [x] 0.4 Verify real browser against standalone Rusty, unavailable-server state, local settings reload, native receipts, two HTTP clients, restart/retry, rejected authorization, and plaintext/key absence in wire objects.
- [ ] 0.5 Extend opaque replication to attachments, multi-device private-key provisioning/rotation and full legacy export/re-encryption migration.

The remainder tracks the full automation rollout. Completed storage slice does not imply the full email rollout or migration. Current production website proof is tracked below. See `implementation.md` for evidence and limits.

## Current scoped automation slice (2026-10-08)

- [x] Independent Worker identity and exact owner-signed Automation grant; shared Rust causal semantic admission.
- [x] Owner UI approval, full-workspace reading disclosure and forged identity rejection.
- [x] Worker website/MIME intake, Clef schema/parser, encrypted Durable Object event/identity/replica state and durable encrypted outbox.
- [x] Actual workerd Automerge + policy WASM tests for scoped Lead/move, chat preservation, failed persistence rollback and ciphertext retry after restore.
- [x] Native concurrent human/automation move conflict quarantine and historical expiry regression tests; rebuild WASM.
- [x] Real workerd → native Rusty → closed/reopened browser: one Lead, duplicate email replay and Interview/Rejected transitions; stale mail stays review; no plaintext or access keys in Rusty storage. AI response is a deterministic test fixture.
- [x] Live Clef inference using authenticated Cloudflare account; production intake applied a synthetic Example GmbH Lead through the real AI binding, retaining existing probability/margin gates.
- [x] Deploy real Worker, frontend and blind Rusty through Cloudflare/Kamal; preserve legacy volume and use a fresh blind volume.
- [x] Real production intake while client closed → live Clef → authorized Lead → blind Rusty → reopened client shows exactly one card in Lead; audit production ciphertext and credential absence.
- [ ] Provision final email destination, verify actual forwarding envelope, approve forwarding and test a real received copy.

## 1. Current pipeline contract and Worker compatibility

- [ ] 1.1 Capture existing intake fixtures from standalone Keeper: human check, limits, JobPosting/OpenGraph extraction, all three Jev decision distributions, chat-only and Lead outcomes, pending/retry and legacy IDs.
- [ ] 1.2 Write outside-in Worker → automation → blind Keeper → two-client acceptance: website Lead created and email Interview/Rejected move applied while clients closed; relay cannot decrypt or author.
- [ ] 1.3 Validate transport-free policy/Automerge WASM in workerd as part of that vertical slice, not a separate product prototype. Record actual host/bundle/runtime failures before choosing a native automation fallback.
- [ ] 1.4 Select Keyhive versus reviewed envelope/key integration with native/browser vectors, identity/provenance mapping and a specified offline revocation cutoff.

## 2. Delegated writes and blind storage

- [ ] 2.1 Add failing shared-policy tests for owner-signed exact workspace/board/command grants, revoked device/grant, forged move metadata, incidental rank changes and unrelated board/content/access mutations; implement receiver-enforced semantic admission.
- [ ] 2.2 Add versioned relay-only pairing, encrypted immutable objects/inventory and HTTPS transport without readable invitations or Editor grants to Keeper.
- [ ] 2.3 Confirm intended failures for plaintext sentinels/keys, tampered envelopes, wrong epoch/document and forwarded unauthorized changes; implement encryption for history/chat/blobs and receiver verification.
- [ ] 2.4 Implement standalone Keeper durability receipts; test failed save, lost response/retry, nonce/scope/hash mismatch, restart and missing attachment coverage.

## 3. Port website intake from Keeper to Worker + Clef

- [ ] 3.1 Preserve form challenge/intake contract and durable 202 receipt, input/rate/inbox limits and configured target; add failing acceptance for bad/expired check and overloaded/persistence-failed intake.
- [ ] 3.2 Port bounded public page extraction and caller field precedence; test JobPosting/OpenGraph, missing page, redirect/private destination and oversized response.
- [ ] 3.3 Replace Jev with Workers AI Clef-flash using equivalent relevance/role/seniority questions; retain probabilities/model/policy version and fixture-check response validation. Classifier failure stays pending.
- [ ] 3.4 Implement independent automation identity, per-workspace durable coordinator, signed existing-board createItem/chat commands and atomic event/proof/outbox persistence.
- [ ] 3.5 Prove replay/concurrent consumers, restart/lost upload response and preservation of distinct identical submissions; preserve imported legacy item IDs and terminal chat/card receipts.

## 4. Forwarded email and existing-card transitions

- [ ] 4.1 Add bounded MIME intake and per-integration forwarding address mapping with durable source identity; expose forwarding-confirmation mail and pending source state.
- [ ] 4.2 Add failing correlation tests: known thread/reference/job URL, two roles at one company, ambiguous link, duplicate mail and spoofed source/target; implement explicit match/review decisions.
- [ ] 4.3 Add Clef application_event schema and evaluated threshold/margin policy; prove interview/refusal/uncertain fixtures and model-unavailable retry.
- [ ] 4.4 Implement existing moveEntity/source-note flow using current status.interview/status.rejected binding IDs. Test renamed/missing columns, archived/deleted/non-leaf cards and no arbitrary board edits.
- [ ] 4.5 Test old forwarded message, manual move during processing, offline conflicting branch, repeated refusal, newer interview after rejection and approval/retry. Implement causal preconditions and receiver conflict/review projection without relying on author wall-clock time.

## 5. Migration and product verification

- [ ] 5.1 Verify independent automation/storage approval, disclosed workspace-wide read scope, review actions, source/card history and error/pending states on isolated browser routes/ports.
- [ ] 5.2 Test automation revocation through another relay, monotonic authority, forward key rotation and device replacement; Keeper storage remains independent.
- [ ] 5.3 Migrate encrypted history with second-client restart recovery; preserve old inbox/results/event/card IDs and explicitly retire old Keeper Editor grants without plaintext fallback.
- [ ] 5.4 Cut form traffic to Worker; remove extraction/classification/raw inbox/card authorship from blind Keeper after both website and email acceptance pass.
- [ ] 5.5 Run required project checks and real standalone-service acceptance; document budgets, deployment prerequisites and residual crypto/alpha risks before default enablement.

## Owner-managed lifecycle (2026-10-09)

- [x] Strict supported type/version registry and owner-signed definition/approval.
- [x] Append-only CRDT active/paused/deleted controls, pause dominance, terminal deletion.
- [x] Durable polling while empty/paused; no classification or retries spent while paused.
- [x] Deployment-authorized browser enrollment; independent identity, immutable owner/workspace binding.
- [x] Signed origin/body/freshness-bound activation and nonce-bound Worker acknowledgements.
- [x] Owner UI add/pause/resume/remove/retry; pending until exact admitted heads are confirmed.
- [x] Isolated real browser/workerd/Rusty lifecycle including failed address and reload.
- [ ] Deploy this lifecycle release and confirm production capabilities.
- [ ] Green remote Verify and automatic frontend release.

## Completion scope requested by owner (2026-10-09)

- [x] One identity photo across workspaces; immediate crop save, durable reload and failure retry.
- [x] Logically stage all current authorized changes, including required shared policy and runtime code.
- [ ] Make remote CI green without dropping meaningful scenario coverage.
- [ ] Confirm GitHub Actions deployed the checked frontend to Cloudflare; fix pipeline if needed.

Remote verification in progress: GitHub Verify `37936123592` proves the owner
visitor → editor → device removal/reconnection flow after moving publication
outside the workspace mutation lock. Automation runtime/owner lifecycle,
production packaging/mobile layout and chat passed in `37935255145`.
Full Verify and the corresponding GitHub → Cloudflare frontend release remain
open. Automation production still requires renewed Cloudflare authentication;
`/v2/capabilities` returned 404 before deployment.
