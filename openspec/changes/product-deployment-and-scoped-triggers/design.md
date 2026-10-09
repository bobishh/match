## Context and current state

Reviewed 2026-10-08. This change is a target architecture, not evidence that all lifecycle paths exist.

| Product or layer | Verified current behavior | Gap addressed here |
| --- | --- | --- |
| Tincanban | Local-first browser application; static Docker image uses nginx; current production static release uses Kamal. A Cloudflare Pages/Workers static adapter is not present. | Keep local use independent; add tested static hosting adapters and reproducible release/recovery procedures. |
| Rusty | Standalone Rust service stores opaque encrypted protocol-2 objects. Production Kamal config uses a fresh persistent blind volume; the previous plaintext volume is preserved. | Reproduce host/network/volume provisioning, backups, upgrades and restore; pair using a public service address without operator secrets in the app. |
| Automation | Cloudflare Worker with Workers AI Clef and per-integration Durable Objects; deployed with Wrangler. Website intake and scoped board writes work. | Model triggers as narrow typed capabilities and make every infrastructure/configuration transition reproducible. |
| Infrastructure | Kamal YAML, shell host setup and current DNS/server configuration exist. The Hetzner README says cloud resources and DNS are not declaratively managed; no Terraform/OpenTofu configuration is present. | Add import-first infrastructure state, plan review, locking, drift checks and controlled apply/restore lifecycle. |
| Trigger disclosure | Current owner approval discloses workspace-wide read access even though writes are limited to approved board commands. | Deliver only the trigger's validated field projection; do not describe current whole-workspace encryption as field-level confidentiality. |

Kubernetes and Helm are not current production owners. They are optional second-stage deployment adapters for the native container products. The Cloudflare Worker is a separate runtime and remains Wrangler-managed; Helm does not emulate or claim to deploy Workers AI or Durable Objects.

The current Worker/Rusty/browser production evidence remains authoritative for the delivered slice. See the linked implementation record for exact versions and known limits. This proposal does not replace that evidence or turn proposed Terraform, static hosting, email delivery, attachment replication or migration into completed features.

## Goals and non-goals

**Goals:** start with one product; keep Tincanban useful offline and without a server; add Rusty from a public address; deploy and operate each product independently; support a separately approved trigger runtime; preserve data through upgrades and resets; make trigger inputs and effects inspectable and constrained.

**Non-goals:** one mandatory hosted account, a control plane that can decrypt workspaces, arbitrary user-authored code, whole-board/whole-workspace trigger grants, automatic legacy protocol negotiation, guaranteed zero-downtime schema changes, or a promise of zero-cost hosting.

## Decisions

### 1. Product boundaries and first-use path

Tincanban is the user-facing local-first product. It works without Rusty, automation, a hosted account or network connectivity for local board operations. A static build can be served by the existing Docker/nginx image and Kamal path, or by a Cloudflare static adapter with the same immutable asset/base-path and health semantics. These are packaging adapters for one app and one persisted board format, not different product protocols.

Rusty is an independently deployable blind storage product. It stores and forwards bounded opaque encrypted objects and receipts. It does not load Automerge, inspect trigger projections, invoke Clef or author board commands. It has its own image, service identity, state volume, backup and restore lifecycle.

Automation is an optional independently deployed Worker product. It accepts configured inputs, evaluates an approved trigger, and proposes only the commands authorized by that trigger. Cloudflare Durable Objects serialize per-workspace execution state; Wrangler deploys the Worker and bindings. The deployment must remain useful when no trigger exists.

The shortest supported journey is: create/use a local board; optionally deploy Rusty or select an existing Rusty URL; verify the service identity and approve pairing; optionally define a trigger and separately approve its exact data/effect scope. The app asks for an address and presents discovery/pairing confirmation. It does not ask users to paste operator/admin tokens, service private keys, import-key files or recovery material into an integration form. Service administration remains an operator-side deployment/configuration concern. Recovery exports, if needed, use a separate protected recovery flow.

### 2. Deployment ownership and reproducibility

Assign one owner to each class of resource:

- Terraform/OpenTofu: cloud server, network, firewall, persistent volume, DNS records, and narrowly scoped deployment identities. Import existing resources before managing them. The first plan must preserve production resources and data; no apply is allowed while a plan proposes unexpected replacement/deletion.
- cloud-init/bootstrap: base OS, Docker prerequisites, mount configuration and minimal host hardening. Replace the current shell-only setup only after behavior is captured and tested.
- Kamal/container images: Tincanban static Docker image, Rusty image, reverse-proxy routes and Rusty persistent-volume mounts. Pin base/runtime versions and deploy immutable image digests or commit-derived tags.
- Helm/Kubernetes (optional second stage): charts for the same Tincanban and Rusty container images, health/readiness contracts, configuration schema and persistence requirements. A chart MUST NOT fork application behavior or introduce a second service protocol. In an environment, exactly one release controller owns each workload: Kamal in current production, Helm only after a deliberate environment migration. Terraform/OpenTofu can own cluster infrastructure, but MUST NOT manage objects also owned by Helm.
- Wrangler: Worker code, Durable Object migrations, custom domains/routes, Queues if adopted, AI bindings, and environment-specific configuration. Secrets are provisioned out of band; never serialize them into Terraform state unless a dedicated encrypted secret resource and access policy is accepted.
- Cloudflare static adapter: static assets only. It must not bundle Rusty secrets, automation identity seeds, operator credentials or server-side Worker bindings into browser assets.

Terraform/OpenTofu state requires a protected remote backend, locking, access control and tested recovery before production resources are imported. Plans run in reviewable CI; apply is explicit. Kamal, Helm and Wrangler remain release tools for their respective application artifacts and must not race Terraform or each other for the same resource. DNS cutover follows a health-checked release and has a documented rollback target. Helm support is a portable deployment adapter, not a claim that Kubernetes currently hosts production.

Each environment (local, CI/test, staging, production) has isolated Worker bindings, DO namespace/storage, Rusty volume, hostnames and credentials. Tests never address production services or reuse production secrets. Workerd tests exercise real Worker/DO semantics; Rust tests exercise the actual Rusty binary/container; browser tests cover the deployed UI contract; a staging end-to-end test joins all three products. AI is a deterministic fixture in tests and a separately measured real binding in staging/production.

### 3. Upgrade, rollback, backup and data safety

Releases are immutable and recorded with source revision, image digest, Worker version, schema/protocol version and infrastructure plan. Readiness checks verify service identity, storage readability, expected protocol and a harmless write/read receipt before traffic shifts.

Before Rusty volume replacement, protocol migration, destructive restore, or a reset that could touch user data, create a consistent backup of service identity, policy, encrypted objects and metadata; verify backup inventory and restore it to an isolated directory/volume; compare object counts/hashes and run a second-client recovery check. Preserve the user's Jobs board and its authorization evidence before any reset. A reset with no verified independent recovery path is blocked.

Application rollback selects the prior compatible image/Worker version and config. If a migration changed durable formats, first stop writers and restore the matching data backup or run a forward-compatible migration; do not point an older binary at unknown newer state. Keep old and new volumes side by side until encrypted coverage, restore, and owner-client reopening pass. Never use a volume rename or container rollback as proof of backup/recovery.

Scaling is explicit. One Rusty writer owns one local persistent volume; a second process or Kubernetes replica MUST NOT mount and write that same volume. Replica count greater than one requires either deterministic scope sharding with one fenced writer and a separate durable volume per shard, or a separately designed shared-storage backend with transactions, fencing and crash-recovery proof. Read replicas require their own consistency model. Automation uses per-workspace fenced serialization; workers may scale across independent workspaces, but the same workspace cannot execute under two live generations. Cloudflare limits, queue depth, DO storage, inference budgets and Rusty object quotas have measured ceilings and visible backpressure. No free-plan or unlimited-capacity promise is implied.

### 4. One current protocol and explicit migration

New clients and services implement the current versioned blind-storage and trigger contracts only. They do not keep a legacy plaintext/Editor path, downgrade, or silently fall back when discovery or authorization fails. Unknown versions fail visibly before sending document data.

Existing installations may still contain older protocol data. Migration is an explicit one-time operation: back up original host state and board locally; validate history/authority; export and re-encrypt through an authorized client into a fresh current-version Rusty volume; verify inventory, receipt coverage and recovery from another client; import or resume pending events under stable IDs; then explicitly revoke old grants and retire the old endpoint. Keep the old backup private for the documented retention period. Migration does not claim remote plaintext erasure. Interrupted migrations remain resumable and cannot claim cutover complete.

### 5. Trigger as typed, versioned, reviewable data

A trigger is a versioned declarative record, not executable code. It identifies a source, a typed condition, a stable document slice, a projection, exact operations and explicit preconditions. A slice reference resembles a lens: it composes validated semantic selectors over stable IDs and typed fields. It never contains a process pointer, an array offset, arbitrary JSONPath, a caller-supplied Automerge path, or a raw document mutator.

A v1 slice selector names an exact workspace and board, stable field/column/entity IDs, allowed entity kinds, and bounded cardinality. Optional filters use a finite typed predicate language (equals, contains, enum match, time window and explicit conjunction). Schema evolution resolves by stable IDs; missing or type-changed fields suspend the trigger for repair. Duplicate matches or cardinality overflow require review. Index/rank/column position never stands in for identity.

The trigger declares its read projection field-by-field and response size limit. The runtime resolves and validates the selector, constructs the minimum typed projection, and passes only that projection and the source event to the decision/action code. No trigger receives an implicit whole Automerge document or all chat/history. The current Worker activation snapshot carries workspace history and therefore does not meet this goal; implementing this design requires an authorized projection boundary, keys/proofs sufficient to validate that boundary, and receiver tests proving omitted fields are not delivered. Existing AES-GCM whole-snapshot encryption does not mean that field-level confidentiality exists.

Owner approval binds the trigger version/hash, workspace, stable selector, read projection, maximum rows/bytes, source, exact operation schemas, target IDs, thresholds, expiry and authority generation. The receiver independently checks the signed grant and actual before/after changes against this schema and its causal base. A model/provider decision is untrusted input and cannot grant permission.

### 6. Exact v1 board actions and causal preconditions

Initial board operations are deliberately small:

- `createLead`: create one job item under the approved board's current Lead column; set only the configured company, role, job URL and explicitly approved source/notes fields. Unknown fields, extra children, schema changes, archive/deletion and unrelated narrative edits are unauthorized.
- `moveAppliedToInterview` and `moveAppliedToRejected`: move one uniquely correlated eligible leaf item from the approved Applied column to the stable Interview or Rejected column. Rejected is a workflow status, never an archive/delete operation. V1 does not authorize moves from Rejected to Interview or arbitrary transitions.

Every command records a stable source-event ID, trigger ID/version, decision policy version, target item ID, source evidence digest/reference, expected current column/status, expected workflow revision and causal heads/frontier. The trigger reads candidate identity and workflow state before any external inference, then re-reads and resynchronizes before authoring. If the item, status, relevant fields or causal frontier changed, the event goes to review. Email dates can reject stale input but cannot prove causal order by themselves. Receiver admission repeats the precondition against the proven causal predecessor; Worker-side checks alone are insufficient.

Concurrent owner edits and trigger commands that are causally incomparable do not silently win by wall-clock order. Preserve both signed branches; keep unauthorized/ambiguous effects quarantined and expose a review action that authors a new command from the current accepted state. The authorized reviewer can accept or dismiss a proposal; the original event and rejected attempt remain in the audit log.

### 7. Durable event and trigger lifecycle

Every accepted input has a stable source namespace and event ID. Provider IDs or a durable ingress receipt are preferred; content hash alone never collapses distinct identical submissions. `jobId` is deterministic for event + trigger version + action; retry `attemptId` is separate. Persist the accepted encrypted source event, normalized metadata, policy/version snapshot, decision, command/proof and exact prepared encrypted upload before acknowledging durable acceptance or performing the remote write.

At-least-once queues retry the same prepared bytes and object ID after uncertain responses. A single fenced Durable Object coordinator per workspace records claims and action receipts. A duplicate event returns the recorded result. The acknowledgement contract says exactly whether it means queued durably, applied locally, or stored remotely; it never reports `applied` before authorized local commit and required storage receipt. Backpressure returns retryable status without dropping accepted durable work.

Triggers move through draft, approved, active, paused, needs-review, revoked and expired. Editing a trigger creates a new immutable version and invalidates approval until reviewed again. Revocation increments a monotonic authority generation, blocks new execution immediately at coordinator and receiver, and prevents stale grants from being restored through another relay. Already delivered plaintext cannot be recalled. Key rotation affects future content only; remote erasure is not promised.

An append-only audit record links event ID, trigger version, input projection hash, decision/model/policy versions, precondition, command ID, applied/review/retry result and storage receipt hash. Logs/UI omit source bodies and credentials by default. Authorized owners can inspect source evidence and decide review items. Audit data is retained encrypted with explicit retention and export/delete policy.

### 8. Failure behavior and release gates

Invalid signatures, unknown protocol versions, wrong target IDs, oversized selectors/projections, schema mismatches, expired/revoked approval, ambiguous matches, model errors, missing heads and stale preconditions fail closed. Transient network/storage errors remain retryable with bounded exponential backoff and jitter. Permanent authorization or schema errors pause the trigger and present repair/review state. Never convert failure into a broader grant or an unencrypted write.

Before production default enablement, test restart at each persist/upload boundary; lost response; duplicate source ID; two distinct identical inputs; two workers on one workspace; manual edits during inference; schema rename/delete/type change; trigger edit/revoke during retry; receiver replay through another peer; full disk/quota; backup restore and application reopening. Record measured limits and tests per adapter.

## Risks and trade-offs

- Smaller projections require a trusted boundary that can validate and sign commands without returning whole workspace plaintext. Until that adapter exists and is tested, existing workspace-wide disclosure must be shown accurately and narrow triggers stay unavailable.
- Terraform state and host credentials increase operational sensitivity. Keep secret values in a dedicated secret manager or protected host/Cloudflare secret store, not browser state or normal plans.
- Independent deployment adds version skew. Exact compatibility is handled by one protocol version, explicit readiness and migration, not hidden fallback. Optional Helm releases deploy the same image/API contract as the current container path.
- CRDT concurrency provides merge, not exclusive command execution. Fenced workspace coordination plus receiver causal checks remain required.
- Backups can contain prior ciphertext, keys and plaintext legacy data. Access control and retention are operator responsibilities; revocation cannot erase copies already delivered.

## Rollout

1. Land and test product/trigger contracts and migration inventory without changing production infrastructure.
2. Implement address-only blind pairing and scoped projection proof behind explicit owner approval; preserve the current route until the new path passes isolated tests.
3. Add local/CI/staging deployment descriptors and Terraform/OpenTofu modules. Import and plan existing resources; review a no-destroy plan before apply.
4. Exercise backups, restore, fresh-volume upgrade, rollback, Rusty/browser recovery, Worker/DO recovery and trigger replay in staging.
5. Cut over one integration only after exact trigger projection, receiver enforcement and restore gates pass. Keep source and event IDs stable; preserve the Jobs board and old backup.
6. Remove runtime legacy modes only after explicit migration and recovery proof. Any old data remains in private backup until the operator's retention policy permits removal.
