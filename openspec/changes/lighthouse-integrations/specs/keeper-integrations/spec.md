## ADDED Requirements

### Requirement: Discover and pin a keeper
Match SHALL discover a service by HTTPS hostname, negotiate protocol support and bind approval to its cryptographically verified identity.

#### Scenario: Supported hostname
- **WHEN** a user enters a compatible service hostname
- **THEN** Match displays its name, fingerprint and available modes before requesting approval.

#### Scenario: Changed identity
- **WHEN** a saved hostname advertises a different person ID
- **THEN** automatic management and provisioning stop and Match requires an explicit new pairing.

#### Scenario: Unsupported service
- **WHEN** discovery fails or no protocol version is shared
- **THEN** Match preserves the current integrations and shows the specific error and retry/upgrade action.

### Requirement: Mutual scoped approval
Match MUST activate only the exact integration and scopes approved by both controller and authenticated service operator; hostname knowledge or a display name SHALL NOT confer authority.

#### Scenario: Two approvals
- **WHEN** both parties approve the same unexpired transcript and all initial scopes persist successfully
- **THEN** Match records an active integration without changing the user's identity.

#### Scenario: One approval only
- **WHEN** one party has not approved
- **THEN** the integration stays pending and no usable workspace credentials or documents are released.

#### Scenario: Tampered scope selection
- **WHEN** a board, mode, key or revision changes after approval
- **THEN** the request is rejected and new approval is required.

#### Scenario: Interrupted provisioning
- **WHEN** transport fails after grants are issued
- **THEN** Match shows pending provisioning, resumes idempotently, or revokes issued grants on cancellation; it does not report completion.

### Requirement: Own-board and least-privilege selection
Match SHALL offer only currently owned boards in v1, default to visitor replication, and request editor access only through an explicit automation selection.

#### Scenario: Replication only
- **WHEN** a user selects two owned boards for replication
- **THEN** the service receives visitor grants for those boards and cannot create or modify cards.

#### Scenario: Ownership changes while pending
- **WHEN** ownership changes before grant issuance
- **THEN** that scope is rejected with a visible reason and other existing integrations keep working.

#### Scenario: Automation upgrade
- **WHEN** the owner explicitly enables a writer on one board
- **THEN** only that board receives a new editor authorization after confirmation.

### Requirement: Identity-scoped integration management
Match SHALL synchronize non-secret integration settings between devices of the same identity and SHALL isolate settings and management rights across identities.

#### Scenario: Multiple keepers
- **WHEN** a controller pairs with two services
- **THEN** each has independent scopes, pinned identity and status.

#### Scenario: Identity switch
- **WHEN** a browser changes to a different identity
- **THEN** it cannot manage the prior identity's integrations using local cached preferences.

#### Scenario: Concurrent policy edits
- **WHEN** two devices submit incompatible updates to one revision
- **THEN** a conflict is displayed and permissions are not silently combined.

### Requirement: Explicit future-board policy
Match SHALL auto-provision future owned boards only under an enabled revisioned policy and fresh per-board owner authorization.

#### Scenario: Policy disabled
- **WHEN** a new board is created with auto-add off
- **THEN** no keeper grant is issued.

#### Scenario: Concurrent tabs
- **WHEN** two owner tabs observe the same new board under one enabled policy
- **THEN** one idempotent scope addition occurs and both show its resulting state.

#### Scenario: Offline keeper
- **WHEN** an enabled addition cannot reach the keeper
- **THEN** local creation succeeds and the pending addition is visible and retried.

### Requirement: Truthful durable replication status
Match MUST derive up-to-date status from authenticated durable coverage for the current document frontier, chat and required blob bytes, separately from transport presence.

#### Scenario: Heartbeat without persistence
- **WHEN** the keeper is reachable but a document save fails
- **THEN** Match shows pending/error, never replica up to date.

#### Scenario: Metadata without attachment
- **WHEN** the document is persisted but a referenced file is missing
- **THEN** Match displays attachments pending with missing coverage.

#### Scenario: New local edit
- **WHEN** a prior receipt covers only the previous frontier
- **THEN** the current replica status changes to saving until new coverage is confirmed.

#### Scenario: Peer offline
- **WHEN** the keeper disconnects after a confirmed save
- **THEN** Match retains last-confirmed time and marks offline without treating later edits as persisted.

### Requirement: Scoped removal and service recovery
Match SHALL distinguish membership revocation, integration disconnect and storage deletion, and MUST preserve local boards and personal identity.

#### Scenario: Remove one board
- **WHEN** the owner confirms removing one keeper scope
- **THEN** a signed revocation is issued for that board and other scopes continue.

#### Scenario: Disconnect across boards
- **WHEN** the user requests disconnect everywhere
- **THEN** Match enumerates authorized scopes, reports any it cannot revoke, and tracks pending delivery.

#### Scenario: Replaced server device
- **WHEN** the same service identity presents a newly certified device with valid recovery/revocation evidence
- **THEN** Match verifies it through core policy and invalidates stale device evidence without transferring ownership.
