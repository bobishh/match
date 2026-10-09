## Specification authoring

- [x] 0.1 Record verified current deployment boundaries and identify Terraform/OpenTofu, Cloudflare static hosting and projection enforcement as target work.
- [x] 0.2 Define product deployment, recovery and versioned typed trigger capabilities with BDD acceptance scenarios.

## Product deployment lifecycle

- [ ] 1.1 Produce an inventory of production resources, ownership, DNS, current image/Worker versions, volumes, secret locations and recovery contacts; retain a no-secret reviewable export.
- [ ] 1.2 Add import-first Terraform/OpenTofu resources for server/network/firewall/volume/DNS and protected remote state with locking, policy checks and drift reporting.
- [x] 1.2a Prepare pinned OpenTofu server/five ordinary DNS declarations with observed import IDs, mandatory encrypted state/plan, S3 locking declaration, exact API inventory and no-mutation adoption guard; validate configuration locally. Production import/backend and remaining cloud resources are still pending.
- [x] 1.2b Record Worker/source ownership, HTTPS/CRDT automation control path, current host/data boundaries and unresolved inventory/recovery work in the infrastructure repository architecture document.
- [ ] 1.3 Replace shell-only host setup with a versioned bootstrap after parity tests; preserve current host and volume without recreation.
- [ ] 1.4 Add independent Tincanban Docker and Cloudflare static adapters with equivalent base-path, health, immutable assets and no browser-bundled server secrets.
- [x] 1.4a Move the existing domain frontends to Workers at unchanged origins; preserve native backends, release hashes, DNS snapshots and rollback routing; verify public routes and isolated browser boot.
- [ ] 1.5 Pin/publish immutable Tincanban and Rusty images; keep Kamal as their release owner and add release metadata/health verification.
- [ ] 1.6 Add optional Helm charts for the same native images and API contracts, including probes, configuration, secret references, resource limits, persistence, upgrade/rollback tests and single-owner deployment guardrails; demonstrate in isolated K3s/Kubernetes before considering production.
- [ ] 1.7 Add Wrangler environment manifests, DO migrations, domain/binding validation and out-of-band secret provisioning; keep production, staging and E2E namespaces isolated. Wrangler remains the distinct Worker deployment adapter.
- [ ] 1.8 Add staging smoke checks for Rusty HTTP durability, Worker health/AI binding, UI origin/CORS and one end-to-end encrypted recovery path across Docker/Kamal, optional Helm and Wrangler adapters.

## Backups, upgrades, rollback and scale

- [ ] 2.1 Design consistent backup/restore for Rusty identity, policies, objects and metadata; verify inventory/hashes in an isolated restore target.
- [ ] 2.2 Before any reset/cutover, back up the user's Jobs board, authority evidence and pending event data; verify a second-client restore before proceeding.
- [ ] 2.3 Test compatible application/Worker rollback and forward-only storage migration; stop writers and restore a matching backup when formats are not backward compatible.
- [ ] 2.4 Test volume-full, Worker/DO restart, failed durable write, lost receipt, quota/backpressure, recovery and single-writer enforcement.
- [ ] 2.5 Measure product resource ceilings and define one Rusty writer per volume plus fenced Worker concurrency per workspace. Prove scope sharding with one volume per shard or implement and test a fenced transactional shared-storage backend before Rusty replica count can exceed one.

## Address-only service pairing

- [ ] 3.1 Specify and implement public discovery, pinned service identity, signed challenge and a pairing request/approval path that never asks the browser to hold operator/admin credentials.
- [ ] 3.2 Seal returned scope storage capability to the approved owner/device and persist it only in private identity-scoped storage.
- [ ] 3.3 Add negative tests for wrong origin/key, replayed challenge, expired offer, revoked service, malformed URL and unknown protocol version.
- [ ] 3.4 Remove new-product runtime legacy routes and fallback; implement explicit export, validation, re-encryption, recovery and grant-retirement migration.

## Scoped declarative triggers

- [ ] 4.1 Define a versioned typed selector/predicate/projection schema over stable workspace, board, entity, column and field IDs with cardinality and byte bounds.
- [ ] 4.2 Implement projection resolution at an authorized boundary; prove unselected fields/chat/history are not delivered to trigger inference/runtime.
- [ ] 4.3 Define owner approval binding exact trigger hash, projection, source, operations, targets, policy thresholds, expiry and generation; require re-approval after edits.
- [ ] 4.4 Implement only `createLead`, `moveAppliedToInterview` and `moveAppliedToRejected`; test unauthorized field/schema/archive/delete/cross-board effects.
- [ ] 4.5 Add pre-inference state capture, resynchronization, expected status/frontier checks, single fenced workspace coordinator and receiver-side causal validation.
- [ ] 4.6 Add durable inbox/outbox, stable event/job/action IDs, immutable retry envelopes, duplicate response and separate attempt tracking.
- [ ] 4.7 Add trigger draft/approve/activate/pause/review/revoke/expire lifecycle, monotonic generation enforcement and encrypted audit inspection/export.
- [ ] 4.8 Test duplicate and identical-distinct events, worker races, crash windows, manual/concurrent edits, stale email, schema change, revocation during retry and relay replay.

## Acceptance and rollout

- [ ] 5.1 Run local, native, workerd, browser and staging acceptance suites against isolated resources and document the exact adapter/version each proves.
- [ ] 5.2 Demonstrate start with only Tincanban; add Rusty by URL; then add one approved trigger without operator token or key file entry.
- [ ] 5.3 Demonstrate backup, isolated restore, Jobs board preservation, second-client reopening, and rollback after a failed release.
- [ ] 5.4 Review measured budgets, projection disclosure, protocol migration, recovery and residual risks before enabling trigger creation by default.
