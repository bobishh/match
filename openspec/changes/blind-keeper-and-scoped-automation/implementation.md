# Blind Rusty implementation evidence

2026-10-08, working-tree implementation and production deployment. No Git commit or push.

## Implemented

Standalone `../mesh-lighthouse/src/lib.rs` exports only `blind`; `main.rs` runs its opaque HTTP router. Old plaintext HTTP intake, joining/provisioning, application-authority library and Jev/native-Iroh dependencies were removed. Pre-existing user changes in `keeper.rs` and `replication.rs` remain untouched and outside the module graph. Rusty signs storage receipts with a service key; it has no application identity, grant, content key, Automerge loader or card command loop.

Protocol 2 provides opaque scope provisioning through an operator token, separate read/write storage tokens stored as keyed hashes, compare-and-set policy revision, storage revocation, immutable ciphertext upload/download and paged inventory. File fsync + atomic rename + parent-directory fsync precede signed acknowledgment. Service identity persists across restart. A filesystem lock excludes concurrent processes. Bounded ciphertext/object/count/storage limits apply; inventory retains metadata rather than all ciphertext. Startup rejects legacy/unknown data directories and missing service keys without deleting source data.

Tincanban `blindEnvelope.ts` uses WebCrypto AES-GCM (32-byte content key, random 12-byte nonce, 128-bit authentication tag), binding opaque scope and key epoch as associated data. `blindClient.ts` pins service identity, hashes canonical wire objects and verifies native Ed25519 receipts bound to the fresh request, exact object, scope, epoch and policy revision. HTTP is allowed only on loopback; production origins require HTTPS. Requests reject redirects and use bounded responses/timeouts.

`blindReplication.ts` carries raw causal history plus exported authorization evidence and signed workspace chat inside ciphertext. It delegates admission to existing `mergeAuthorizedWorkspace` and `receiveChat`, never to a relay-provided application assertion. Durable cursors advance only after successful admission/persistence. Uncertain uploads retry identical ciphertext; unchanged snapshots are not uploaded again. Clients poll while open; Rusty retains data while clients are closed.

**Sync → Blind Rusty** supports owner setup, private access export/import for existing board members, manual retry, local disconnection and error/pending state. Credentials stay in identity-scoped local IndexedDB; content keys and operator tokens never enter shared board state. The operator form clears its token after the attempt. Setup requires an already owned board; private access import requires an existing board, separately obtained through normal signed membership.

## Executed evidence

- Acceptance failures confirmed before implementing independent blind startup, encrypted round trip, admission/cursor behavior, concurrent-writer exclusion and rejection of old HTTP inbox directories.
- Native `cargo test`: storage restart and immutable retry, two HTTP clients, signed receipts, read token denied upload, revoked write denied, wrong ciphertext hash, missing auth, failed persistence without receipt, process exclusion and preservation/refusal of legacy plaintext state.
- Vitest: AES-GCM round trip and tamper/wrong key/scope/epoch rejection; pinned receipt verification and signed mismatch/replay/forgery rejection; no cursor advancement on rejected application admission; lost-response retry reuses identical ciphertext.
- Existing signed admission regression suites: 30 passed, 1 skipped.
- Real Playwright browser with isolated port and a temporary standalone Rusty process: encrypted owned board/chat upload, native signature accepted, no title/content key in stored object, subsequent pull, settings reload, unreachable storage error with local board remaining available.
- Production frontend build, TypeScript, ESLint code checks, dead-code/dependency-boundary checks, duplication budget and pattern checks passed. Build retains existing dependency annotation/chunk-size warnings. The aggregate `npm run quality` stops on stale suppression entries in untouched `src/sync/telemetry.ts` (two `no-unsafe-argument`, one `no-unsafe-assignment`); `eslint src --pass-on-unpruned-suppressions` passes. Suppression metadata was inspected through a temporary copy and left unchanged.

## Remaining full-rollout work

Worker intake, Clef response parsing, MIME ingestion/correlation, Interview/Rejected action selection, encrypted Durable Object event/identity persistence and owner-signed Automation grants now exist in the working tree. Local full browser acceptance below proves a delivered lead and existing-card status moves. Production Worker and live Clef inference are now deployed and verified separately below. A provisioned email destination is not claimed. Broad Editor grants do not substitute for Automation authorization.

## Scoped automation executed evidence

Automation has its own identity. Owner approval exports a private activation packet containing encrypted-storage access, workspace history/proofs and an exact signed board/column/field scope. The UI discloses workspace-wide reading access and restricts approval to the owner of a workspace with one active job-search board. This is a disclosed workspace read scope, not column-level cryptographic secrecy.

Native receiver policy checks changes against their causal predecessor state, binds the signed scope to the authorization proof, rejects unrelated board/schema/access edits and quarantines automation placement conflicts with concurrent human moves. Expiration gates current execution/access. Historical admission does not use the receiver's current clock to erase earlier valid writes; expiry alone cannot establish when an unseen offline change was authored. Workspace epoch/revocation remain the receiver-enforced cutoff.

Executed on 2026-10-08: owner approval helper red/green test; frontend TypeScript/build, targeted lint, dependency boundaries, dead-code, pattern and duplication checks pass. Approval/encryption/receipt/retry: five focused tests pass; redirect compatibility test separately confirmed red then green. Shared permissions/proofs/admission: 48 passed, one skipped. Native policy: 185 passed, three ignored; regenerated policy WASM. Worker Node tests: 15 passed. Workerd runtime suite: 20 passed, including actual Automerge and policy WASM scoped Lead creation/move, malformed chat rejection, opaque chat preservation, persistence rollback, encrypted outbox retry after restore, stale workflow rejection and a real 2.5 MB Durable Object state round trip. Wrangler dry-run build succeeds; no deployment implied.

Final `playwright.automation-worker.config.ts` acceptance: one passed, 16.2 seconds. Actual workerd, native Rusty and browser UI use isolated local ports and temporary storage. Browser owner approval rejects forged Worker identity and exports the signed activation packet. With the browser closed, HTTP intake creates `Nacre Light Integration GmbH — Principal Systems Engineer`; after reopening, the authorized client sees the Lead. Forwarded MIME events move the same card to Interview and Rejected while the client is closed. Identical message replay produces no additional write; a message dated 2000 stays in review and leaves the card unchanged. Rusty objects contain ciphertext-only wire fields; all stored files are checked for absence of card/source sentinels and content/read/write keys. The AI wrapper supplies deterministic Clef-shaped responses; this is no claim of live model accuracy or an actual delivered Gmail message. Test storage is cleaned afterward.

Full-run failures corrected: JSON-string workflow parsing in Rust; unsupported `redirect: "error"` replaced with manual redirect handling and explicit refusal; activation stays inside the Durable Object to avoid transferring nonserializable CryptoKeys through RPC. Encrypted replica persistence is chunked below SQLite's per-cell limit; generation-pointer swap, chunk inserts and old-generation deletion occur in one synchronous transaction. Email candidates/workflow are captured before classification and checked after resync; missing/old dates and status regressions stay in review.

External checks: Wrangler OAuth is authenticated and the real Worker uses the Workers AI Clef-flash binding. The earlier connected-API authentication failure did not establish the production account state. `jobs@inbox.meta-uber-engineer.dev` remains a proposed destination. Gmail has the Работа label filter; forwarding remains disabled. Neither Postfix nor an independently hosted SMTP server is required by the selected Email Routing → Worker design.

Blind attachment replication, attachment-completeness receipts, private content-key distribution to enrolled devices, automatic key rotation/offline revocation cutoffs and legacy inbox/results migration remain pending. Current board/chat replication is whole-history snapshots, not encrypted Automerge delta sessions; 16 MiB ciphertext/object, 10,000 objects and approximately 1 GiB encoded storage/scope bound growth. No automatic retention/compaction exists. Revoking a board grant does not erase old plaintext or content keys; local disconnect does not revoke remote tokens.

Production Rusty now uses a fresh blind volume; the old plaintext volume and stopped container remain preserved for explicit migration. Old Keeper board grants still require separate revocation. The removed plaintext ingestion endpoint is not an intake destination; production intake uses the Worker. Existing form integrations still need an explicit traffic cutover. Old protocol 1 keeper integration scenarios do not establish protocol 2 compatibility.


## Production deployment and real Clef evidence (2026-10-08)

Infrastructure uses `hetzner_playground` Kamal on `46.224.124.116`. The obsolete `hetzner-box` alias for `37.27.217.160` was removed from local SSH configuration with a private backup; no VM was deleted.

- Frontend: `https://match.meta-uber-engineer.dev`, Kamal version `blind-automation-20261008-C-XSXbwM`, asset `index-C-XSXbwM.js`.
- Worker: `https://automation.meta-uber-engineer.dev`, real `src/index.ts` and `@cf/cloudflare/clef-flash` AI binding, applied Lead version `bbb9d044-2489-4522-82c1-00c13dadf4bf`; current version `8fb27e40-1a4a-4b64-a4ca-664a86e5c1e5` adds an accurate review reason without changing thresholds. No test AI wrapper is deployed. Worker health returns ready; script workers.dev and preview routes are disabled.
- Rusty: `https://ingest.meta-uber-engineer.dev`, Kamal image `ghcr.io/bobishh/mesh-lighthouse:blindprep-kamal-20261008-1f80da2d3771`, fresh volume `mesh_lighthouse_blind_20261008`. Public discovery reports protocol 2, encrypted replication, no application writes and no classification. HTTPS scope/receipt round trip and revoked-token denial passed. Legacy volume `mesh_lighthouse_data_reset_20260929` is intact.

Actual production owner UI exported the exact signed scope for integration `production-proof-20261008`; activation succeeded. A negative human-check request was rejected. With the client closed, full synthetic Example GmbH / Principal Distributed Systems Engineer text passed real Clef: relevance `yes` .7876, `no` .1299, `uncertain` .0825; role `backend` .85; seniority `staff_principal` .8971. The production event is `applied`, action `created-lead`, card `automation-If1T8rYBTY2_B5MoANYKrSa_l2fZ0kAq`. Two earlier uncertain production submissions stayed in review and did not mutate the board. Existing >=.7 probability and >=.2 margin gates were retained.

Live Clef also exposed that response confidence is independent of the chosen label probability. Parser validation now checks both independently and continues to require argmax, bounded probabilities and normalized distributions. The exact live response first failed its regression test, then passed after correction. Nonsecret input/model/deployment evidence: `workers/automation/evidence/production-clef-proof-2026-10-08.json`. Private activation packets and storage credentials remain outside the repository.

Read-only production Rusty audit streamed every file from the fresh active volume and compared locally held access keys in memory. All 12 stored objects have only `{sequence, objectId, object}` with inner `{version, scopeId, keyEpoch, nonce, ciphertext}`; both policy files contain only revision, revocation state and token MACs. Across all 16 files, synthetic vacancy/card/source markers and six encountered read/write/content-key values (encoded and decoded) were absent. Owner scope matched inventory. One active board scope and one revoked preparation-proof scope remain; no data was deleted. See `workers/automation/evidence/production-rusty-audit-2026-10-08.json`.

Production browser acceptance passed in an isolated persistent Chromium profile against the deployed frontend. The client was closed before intake; after reopening and encrypted sync, exactly one `.lead-card` with Example GmbH / Principal Distributed Systems Engineer appeared in the Lead region. Owner setup and post-write reopening were exercised separately against real endpoints; no local server, injected Automerge state or AI mock supplied this production result. The final screenshot is retained privately at `~/.local/share/tincanban-automation/production-acceptance/lead-after-production-reopen.png`. Acceptance source: `e2e/automation-production.spec.ts`; nonsecret result retained outside the repository: `~/.local/share/tincanban-automation/production-acceptance/production-evidence.json`. Final production Playwright run: one passed, one skipped (existing owner-approved packet reused), zero failed, 7.2 seconds. Initial owner setup separately passed. TypeScript and Knip checks pass.

## Owner lifecycle implementation (2026-10-09)

`automation` CRDT records now hold strict `job-intake@1` definitions, signed public
approvals, executor binding and append-only desired commands. Concurrent pause
wins; removal stays terminal across restart and stale activation. DO alarms poll
controls with no queued work and stop before event claiming, AI and retry increments
when paused. Owner-only browser management adds, retries, pauses, resumes and removes
instances; JSON/operator credential export is removed from the ordinary UI.

Owner enrollment uses deployment public-ID allowlisting and fresh signed requests,
immutable DO owner/workspace binding and a separate Worker identity. Activation
signature covers the canonical private packet hash, origin and instance. Existing
causal Rust admission remains mandatory. Verified routing is published only after
successful cryptographic activation; Rusty outage leaves explicit stored/pending
state. Status uses Worker certificate/root verification and signed request nonce,
workspace, instance, grant, time and exact control heads. Unsynced state cannot
appear confirmed. New instances currently enable website intake; email routing
is not provisioned or advertised as ready.

Evidence: shared contract/protocol tests including forged/stale acknowledgement;
30 workerd runtime tests; 1096 root unit tests passed (one existing skipped).
Real isolated browser lifecycle passed (53.1 seconds): wrong Worker address fails
without creating a record, then addition, pause, resume and terminal removal each
receive verified acknowledgement; removed state survives reload. Intake/MIME scoped
mutation and ciphertext regressions remain separate acceptance. Deployment and
remote CI are recorded only after they complete.

Production lifecycle deployment (2026-10-09): Cloudflare Worker version
`275657d2-371f-4435-8636-0db98475e07a`, uploaded and deployed through Wrangler.
`GET https://automation.meta-uber-engineer.dev/v2/capabilities` returns HTTP 200,
version 2, enrollment enabled and `job-intake@1`; Email Routing remains disabled.
`/health` reports ready. CORS permits the production Match origin. This confirms
the deployed API contract; owner add/pause/resume/remove execution is covered by
the real isolated browser/workerd/Rusty lifecycle suite.
