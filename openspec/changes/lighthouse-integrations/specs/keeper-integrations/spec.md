## ADDED Requirements

### Requirement: Discover and pin a keeper
tincanban SHALL discover a service by HTTPS hostname, negotiate protocol support and bind approval to its cryptographically verified identity.

#### Scenario: Supported hostname
- **WHEN** a user enters a compatible service hostname
- **THEN** tincanban displays its name, fingerprint and available modes before requesting approval.

#### Scenario: Changed identity
- **WHEN** a saved hostname advertises a different person ID
- **THEN** automatic management and provisioning stop and tincanban requires an explicit new pairing.

#### Scenario: Unsupported service
- **WHEN** discovery fails or no protocol version is shared
- **THEN** tincanban preserves the current integrations and shows the specific error and retry/upgrade action.

### Requirement: Mutual scoped approval
tincanban MUST activate only the exact integration and scopes approved by the authenticated service; hostname knowledge or a display name SHALL NOT confer authority. Services without owner-origin admission support SHALL retain the separate operator and controller approvals.

#### Scenario: Two approvals
- **WHEN** both parties approve the same unexpired transcript and all initial scopes persist successfully
- **THEN** tincanban records an active integration without changing the user's identity.

#### Scenario: One approval only
- **WHEN** one party has not approved
- **THEN** the integration stays pending and no usable workspace credentials or documents are released.

#### Scenario: Owner-origin admission
- **WHEN** a service advertises owner-origin admission and its authenticated owner reviews and approves exact owned-board scopes from an allowed Tincanban origin
- **THEN** Tincanban signs that exact origin into the offer, omits the redundant operator step, and provisions only after Rusty returns signed approval for the same origin, controller, policy and board set.

#### Scenario: Legacy service approval
- **WHEN** discovery omits owner-origin admission support
- **THEN** Tincanban omits the origin field and retains the operator approval link and controller decision.

#### Scenario: Owner-origin mismatch
- **WHEN** a service status reports a different origin, controller, policy or approved board set than the signed offer
- **THEN** Tincanban rejects the status and releases no board access.

#### Scenario: Tampered scope selection
- **WHEN** a board, mode, key or revision changes after approval
- **THEN** the request is rejected and new approval is required.

#### Scenario: Interrupted provisioning
- **WHEN** transport fails after grants are issued
- **THEN** tincanban shows pending provisioning, resumes idempotently, or revokes issued grants on cancellation; it does not report completion.

#### Scenario: Withdraw a stuck pairing
- **WHEN** an owner cancels a pairing whose provisioning outcome is uncertain
- **THEN** tincanban fences the pairing with a signed withdrawal, durably revokes only its exact approved scopes, and keeps cancellation pending and retryable until Rusty confirms cleanup; dismissing it moves the request to restorable history without granting access or claiming cancellation.

### Requirement: Owner-approved keeper scope selection
Tincanban SHALL offer only currently owned boards. Dedicated keeper integrations SHALL use an independently verified owner-signed Editor grant after both parties approve the exact scopes. Ordinary workspace invitations SHALL retain their selected role, including Visitor.

#### Scenario: Keeper editor grant
- **WHEN** both parties approve two currently owned boards for a keeper integration
- **THEN** Rusty accepts only matching owner-signed Editor grants for those exact boards.

#### Scenario: Ordinary visitor invitation
- **WHEN** an owner sends a generic workspace invitation with Visitor role
- **THEN** the ordinary invitation flow preserves Visitor role and does not inherit keeper Editor policy.

#### Scenario: Ownership changes while pending
- **WHEN** ownership changes before grant issuance
- **THEN** that scope is rejected with a visible reason and other existing integrations keep working.

#### Scenario: Automation upgrade
- **WHEN** the owner explicitly enables a writer on one board
- **THEN** only that board receives a new editor authorization after confirmation.

### Requirement: Identity-scoped integration management
tincanban SHALL synchronize non-secret integration settings between devices of the same identity and SHALL isolate settings and management rights across identities.

#### Scenario: Multiple keepers
- **WHEN** a controller pairs with two services
- **THEN** each has independent scopes, pinned identity and status.

#### Scenario: Identity switch
- **WHEN** a browser changes to a different identity
- **THEN** it cannot manage the prior identity's integrations using local cached preferences.

#### Scenario: Concurrent policy edits
- **WHEN** two devices submit incompatible updates to one revision
- **THEN** a conflict is displayed and permissions are not silently combined.

### Requirement: Isolated operator and identity sessions
Lighthouse SHALL keep operator administration and Tincanban identity sessions in separate validated browser contexts. Signing into an identity MUST NOT overwrite or create operator authority. Each logout MUST revoke and clear only the selected session, and operator-only endpoints MUST continue to require a valid operator session and CSRF token.

#### Scenario: Identity sign-in while operator is authenticated
- **WHEN** a browser has a valid operator session and completes Tincanban identity exchange
- **THEN** both sessions remain independently valid, operator approvals remain available, and identity exchange grants no operator authority.

#### Scenario: Identity cannot approve
- **WHEN** a browser has only a valid Tincanban identity session and requests an operator approval
- **THEN** the request is denied and the identity session is not promoted.

#### Scenario: Scoped logout
- **WHEN** a browser has valid operator and identity sessions and logs out of one context
- **THEN** only that session is revoked and cleared; the other remains valid.

#### Scenario: Legacy identity cookie
- **WHEN** a pre-migration identity session arrives in the legacy operator-cookie slot
- **THEN** Lighthouse derives its role from the server-side session and never treats the cookie name as operator authority.

### Requirement: Explicit future-board policy
tincanban SHALL auto-provision future owned boards only under an enabled, owner-approved revisioned policy and fresh per-board owner authorization. Approval SHALL bind a sorted, unique baseline of all eligible owner scopes present before approval. Future automation SHALL exclude every baseline scope, even when user left that scope unchecked. A missing legacy baseline SHALL fail closed for automatic additions.

#### Scenario: Policy disabled
- **WHEN** a new board is created with auto-add off
- **THEN** no keeper grant is issued.

#### Scenario: Existing unchecked scope
- **WHEN** future-board policy is approved while an existing eligible board is unchecked
- **THEN** that board remains outside the integration and only a board created after the approved baseline may be auto-added.

#### Scenario: Legacy policy without baseline
- **WHEN** an active integration has no verified baseline
- **THEN** no future board is auto-added until the owner explicitly approves a refreshed policy.

#### Scenario: Concurrent tabs
- **WHEN** two owner tabs observe the same new board under one enabled policy
- **THEN** one idempotent scope addition occurs and both show its resulting state.

#### Scenario: Offline keeper
- **WHEN** an enabled addition cannot reach the keeper
- **THEN** local creation succeeds and the pending addition is visible and retried.

### Requirement: Truthful durable replication status
tincanban MUST derive up-to-date status from authenticated durable coverage for the current document frontier, chat and required blob bytes, separately from transport presence.

#### Scenario: Heartbeat without persistence
- **WHEN** the keeper is reachable but a document save fails
- **THEN** tincanban shows pending/error, never replica up to date.

#### Scenario: Metadata without attachment
- **WHEN** the document is persisted but a referenced file is missing
- **THEN** tincanban displays attachments pending with missing coverage.

#### Scenario: New local edit
- **WHEN** a prior receipt covers only the previous frontier
- **THEN** the current replica status changes to saving until new coverage is confirmed.

#### Scenario: Peer offline
- **WHEN** the keeper disconnects after a confirmed save
- **THEN** tincanban retains last-confirmed time and marks offline without treating later edits as persisted.

### Requirement: Scoped removal and service recovery
tincanban SHALL distinguish membership revocation, integration disconnect and storage deletion, and MUST preserve local boards and personal identity. Removal SHALL revoke local access immediately, persist a per-scope pending operation, and remain visible across dialog close, reload and restart until Rusty returns a verified signed cleanup receipt. Rusty SHALL tombstone the exact integration/scope generation before cleanup and SHALL block stale retries or owner offers from restoring it.

#### Scenario: Remove one board
- **WHEN** the owner confirms removing one keeper scope
- **THEN** a signed revocation is issued for that board and other scopes continue.

#### Scenario: Disconnect across boards
- **WHEN** the user requests disconnect everywhere
- **THEN** tincanban enumerates authorized scopes, reports any it cannot revoke, and tracks pending delivery.

#### Scenario: Replaced server device
- **WHEN** the same service identity presents a newly certified device with valid recovery/revocation evidence
- **THEN** tincanban verifies it through core policy and invalidates stale device evidence without transferring ownership.

#### Scenario: Pending removal survives reload
- **WHEN** Rusty accepts a disconnect request but cleanup is pending or unreachable
- **THEN** local membership stays revoked and Sync shows the exact integration and retry action after reload.

#### Scenario: Fresh re-add after removal
- **WHEN** both parties approve a new pairing after complete removal
- **THEN** Rusty activates a fresh operation with a grant epoch newer than the removed generation and rejects replay of the old disconnect or offer.
