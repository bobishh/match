## Context

Reviewed 2026-09-28. tincanban already issues multi-workspace invitations in `src/sync/deviceSyncHost.ts`, checks owner authority per board, and displays Lighthouse using signed peer metadata. Service-side joining remains singleton. The standalone Lighthouse and `crates/tincanban-lighthouse` are separate implementations; current browser tests launch the latter, so they cannot certify the standalone service.

Companion: [service design](../../../../mesh-lighthouse/openspec/changes/multi-integration-service/design.md). Canonical shared HTTP contract: [protocol.md](../../../../mesh-lighthouse/openspec/changes/multi-integration-service/protocol.md). This document specifies future behavior.

## Goals / Non-Goals

**Goals:** Connect a self-hosted keeper from tincanban; select multiple owned boards; explicitly approve both ends; manage scopes and show durable replication evidence; preserve identity and existing documents.

**Non-Goals:** Replacing personal-device enrollment, hosted billing, Twang support in this release, automatic recovery of board ownership, or treating replicas as versioned backups.

## Decisions

### 1. Integrations are identity-scoped preferences

Store integration ID, service origin, pinned service person ID, approved device certificates, selected scopes, verified grant epochs, the approval-time eligible-scope baseline, future-board consent and pending removal operation in the identity's personal root. Enrollment copies this descriptor to a new device; the personal root is not an ongoing cross-device sync channel, so Rusty's signed integration status and revision remain canonical. Keep workspace grants and verified authority in their existing authoritative stores. HTTP session secrets and operator credentials never enter a workspace document.

One tincanban identity can use multiple keepers; one keeper can accept multiple unrelated controllers. Switching identity changes the visible integrations. Identity enrollment and board imports never silently adopt a keeper integration from another identity. Conflicting policy revisions display a conflict and suspend automatic additions rather than unioning permissions.

### 2. Connection UX

Sync → Add keeper → hostname → discovery → choose owned boards and future-board policy → request admission → compare code/approve → provisioning → replication status.

Keeper integrations use Editor grants because Rusty writes replicated boards; both parties approve the exact initial board set and Tincanban verifies the independent owner-signed grants. Generic workspace invitations retain their own chosen role, including Visitor. An operator approval URL opens on the discovered service origin and requires its operator session; it is not a public approval capability.

Show service identity fingerprint and the same transcript code at both ends. HTTPS locates the service; the saved person ID pins it thereafter. A different identity at the same hostname requires a new trust decision, never automatic acceptance. Service operator authentication stays on Lighthouse, not in a tincanban password field.

### 3. Approval is a shared state machine

Use the canonical protocol's signed offer/challenge and explicit tincanban and operator decisions. Both approvals bind the exact board IDs, modes, identity keys, nonce and expiration. Changing the set invalidates approvals. MetaMesh Rust owns verification and legal transitions; browser TS executes HTTP, persistence and UI effects.

Only after both approvals does tincanban activate a short-lived existing workspace invitation and deliver it to Lighthouse. Reuse WorkspaceJoinHandshake for grants, authority, documents and acknowledgement. The service presents its pinned identity instead of generating a new identity per invite. Read-only replica admission must be verified in both adapters before exposing the mode.

Pairing reaches Active only after every selected scope has durably installed its validated initial data. Disconnection or a failed scope shows provisioning/retry, not success. IDs and commit decisions are persisted for idempotent resume. Cancellation before activation leaves no usable scope membership; any grants already issued are tracked and revoked, never silently forgotten.

### 4. Management and future boards

Adding/removing scopes is a signed revisioned operation with an explicit affected-board list. The operator approves a controller once for a capacity/policy envelope; later additions within that envelope require fresh workspace-owner authorization but not another operator click. Expanding the envelope requires operator approval.

Auto-add future owned boards is off by default. Enabling it signs a sorted baseline of every currently eligible owned board into pairing approval and provisioning. Only owner boards absent from that baseline can be automatically offered later; a preexisting unchecked board stays excluded. Missing legacy baseline fails closed. An authorized online owner device issues normal per-board Editor grants when a later board appears; the keeper cannot grant itself access. Deduplicate concurrent owner tabs by integration/workspace/policy revision. Failed provisioning remains visible and retryable. Turning policy off cancels pending additions. Authority is rechecked before every grant.

Removal revokes local access immediately and persists an exact per-scope pending operation. Sync keeps the integration visible after closing or reloading and offers retry. Rusty tombstones the exact grant generation before deleting its scope and signs completion only after cleanup; retries are idempotent and stale offers cannot restore removed scopes. Disconnect enumerates only scopes the current identity can revoke. A transfer of ownership makes that scope require its new owner's decision. Disconnect never deletes the user's identity or local boards. Service storage deletion is a separate retention action; previously copied data cannot be remotely guaranteed erased.

### 5. Replication evidence

Keep transport presence and replica state separate. Each board displays persisted document frontier, chat coverage and missing attachment count from authenticated evidence. A report must identify the integration, scope, service identity/device and requested frontier/challenge. Reusing existing durable ACK evidence is preferable; never infer persistence from heartbeat or document arrival.

Labels: Connecting, Saving changes, Replica up to date, Attachments pending, Offline (last confirmed time), Access revoked, Needs attention. Unavailable chat/blob support is explicit; never show complete replication while missing either. Frontier coverage accounts for descendants, not just equality of head lists. A new local edit immediately makes the current confirmation insufficient.

### 6. Ownership of implementation

MetaMesh core: signing domains, pairing transition validation, certificate/grant/revoke checks, durable ACK semantics; fixtures shared across WASM/native.
tincanban: board eligibility, UX, integration preference persistence and mapping product data to coverage.
Lighthouse: capacity/admission, operator UI, scope storage and scheduling.
Do not clone authority logic into a new TS keeper client.

## Risks / Trade-offs

- Visitor forwarding may currently be blocked → verify original author evidence, distinguish author from transporting peer, and add browser/native negative tests before release.
- Trusted host can read replicated content → disclose destination and data scopes at approval; v1 is trusted replication, not blind encrypted storage.
- Operator admission does not prove board ownership → verify both independent authorities.
- Offline clients may not learn revocation instantly → enforce monotonic revocation once received and report acknowledgement lag.
- Shared API drift → one service-owned contract plus common fixtures and actual standalone-binary browser tests.

## Migration Plan

Ship service discovery and protocol support before enabling tincanban UI. Preserve all identity/grant/document IDs. Existing keeper membership becomes a managed integration only after explicitly binding the service identity and controller. Unsupported services show an actionable upgrade message. Roll back the UI independently; keep records and signed authority intact.

## Open Questions

No product decision blocks implementation. Visitor forwarding, complete chat/blob evidence and current device-revocation propagation are mandatory implementation investigations with failing tests, not assumptions of existing support. Capacity defaults must be justified by the service acceptance run before documenting a supported scale.
