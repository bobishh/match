## ADDED Requirements

### Requirement: Connect Rusty by a verified address
Tincanban SHALL connect to the current Rusty protocol using its public HTTPS address and an explicit cryptographic trust check. The user interface MUST request neither an operator/admin token nor a service private key, recovery secret, or private access file. Discovery MUST reject unsupported protocol versions, origin mismatch, malformed addresses, and service identity changes before transmitting workspace data. The UI SHALL retain the name Rusty and present one address field and one Connect action for this flow.

#### Scenario: Connect to the configured Rusty service
- **GIVEN** Rusty advertises the supported protocol at a valid HTTPS origin and its service identity matches the trusted identity
- **WHEN** an owner enters the address and connects
- **THEN** the client completes signed discovery and owner-device authorization
- **AND** no operator credential or private key file is requested
- **AND** the board remains usable while encrypted replication starts.

#### Scenario: Reject an untrusted or changed service
- **GIVEN** the entered endpoint has an unknown service identity, changed pinned identity, wrong advertised origin, or unsupported protocol
- **WHEN** the client connects
- **THEN** it reports a visible verification or compatibility error before uploading workspace bytes
- **AND** existing local boards and saved Rusty credentials remain unchanged.

### Requirement: Authenticate each Rusty controller with an owner device
Rusty SHALL accept scope enrollment only from an explicitly trusted owner identity and an allowed controller device whose complete device-certificate chain verifies to the configured owner root. A controller request SHALL bind the Rusty origin and service identity, scope ID, owner person ID, device ID and key, policy revision, expiry, and one-use challenge. The owner device SHALL sign the exact enrollment request, including commitments to the read and write capabilities. Rusty SHALL verify the service-signed challenge, owner root, full certificate chain, signer, commitments, expiry, replay state, and expected policy revision before creating or changing a scope. Unknown, expired, replayed, or concurrently stale requests MUST fail closed.

#### Scenario: Enroll a scope from an allowed owner device
- **GIVEN** Rusty is configured with the owner's trusted identity root and the current device is on its allowed controller list
- **WHEN** the owner confirms connection and the device submits a fresh signed challenge response
- **THEN** Rusty creates the requested scope at the expected policy revision
- **AND** the browser verifies the signed receipt and saves its locally generated capabilities and receipt privately.

#### Scenario: Reject a device outside the owner allowlist
- **GIVEN** a device certificate is valid but its device ID is not allowed to control Rusty
- **WHEN** that device attempts scope enrollment
- **THEN** Rusty denies the request without creating or changing a scope.

#### Scenario: Reject stale or replayed enrollment
- **GIVEN** a challenge is expired, already consumed, bound to another scope/device/origin, or refers to an obsolete policy revision
- **WHEN** a client submits it
- **THEN** Rusty rejects the request and requires a fresh owner-device challenge.

### Requirement: Keep Rusty capabilities private to the owner's devices
Read and write capabilities and the content-encryption key SHALL be stored in private, identity-scoped client storage or an explicitly protected recovery mechanism. They MUST NOT be placed in shared workspace documents, board invitations, workspace grants, ordinary shared personal-root fields, or browser-visible server configuration. Scope enrollment MAY transmit read/write bearer capabilities to Rusty over HTTPS so it can establish access policy; Rusty MUST retain only one-way verifier material and MUST never receive the content-encryption key. Workspace plaintext, application grants, and authorization records MUST remain client-side. Rusty SHALL receive encrypted objects and only the minimum scope policy required for storage.

#### Scenario: Persist an authorized scope
- **WHEN** the client creates scope capabilities and Rusty returns a valid signed enrollment receipt after owner-device approval
- **THEN** the client stores them in private storage scoped to that local identity
- **AND** switching identities cannot expose, apply, or overwrite those capabilities.

#### Scenario: Keep capabilities out of shared board data
- **WHEN** an owner connects Rusty or enrolls another board participant
- **THEN** no read token, write token, or content key appears in the workspace document, invitation, workspace grant, or ordinary shared personal-root record.

#### Scenario: Another board participant cannot use the scope
- **GIVEN** a person has Editor or Visitor access to a workspace but is not an allowed controller device for the owner identity
- **WHEN** that person inspects synced workspace state or attempts Rusty scope management
- **THEN** they receive no Rusty capability and cannot manage the scope.

### Requirement: Share Rusty access through authenticated same-person device sync
The product SHALL make an owner's Rusty access available on other authorized devices of that same identity through authenticated encrypted device synchronization. Transfer SHALL bind the private capability to the recipient device and owner identity, verify the recipient's full device certificate chain and current authorization, and preserve scope/service identity and policy revision. It MUST NOT use a board-wide document, normal participant invitation, operator token, or unprotected import/export file as the transfer channel. Until a private device-sync channel is implemented and verified, the product MUST show additional-device access as unavailable or pending and MUST NOT claim that a second device can recover or manage the Rusty scope automatically.

#### Scenario: Transfer access to a newly enrolled same-person device
- **GIVEN** an existing owner device has an active Rusty scope and approves enrollment of a new device under the same identity
- **WHEN** authenticated device enrollment completes
- **THEN** the new device receives the scope capabilities only inside the encrypted, signed enrollment exchange
- **AND** it verifies identity, recipient device, service identity, and scope binding before saving them privately.

#### Scenario: Synchronize access to an already-enrolled owner device
- **GIVEN** two owner devices are enrolled and an authorized private device-sync channel is available
- **WHEN** Rusty scope capabilities are created, rotated, or revoked on one device
- **THEN** the other device receives the corresponding versioned private update over that channel
- **AND** stale updates cannot restore a revoked scope or older policy revision.

#### Scenario: Private device-sync channel is unavailable
- **GIVEN** Rusty is connected on one device but no verified private device-sync channel exists
- **WHEN** another device opens the same identity
- **THEN** the app does not imply that Rusty is connected there and does not expose credentials to board members
- **AND** the local board and existing device-pairing flow continue to work.

### Requirement: Disconnecting Rusty preserves local work
Disconnecting Rusty SHALL disable local replication without deleting or replacing the user's board, identity, device certificates, or unrelated membership state. A failed service verification or enrollment SHALL leave the current workspace and saved scope configuration unchanged. Service-side revocation and local disconnection SHALL be represented separately so the UI does not claim remote credentials were revoked when only local access was removed.

#### Scenario: Rusty is unavailable during replication
- **GIVEN** an owner has a saved local board and an active Rusty configuration
- **WHEN** Rusty becomes unavailable
- **THEN** local reads and edits remain available
- **AND** replication reports a retryable failure without discarding the board or its authorization evidence.

#### Scenario: Remove a local connection
- **WHEN** an owner disconnects Rusty from this device
- **THEN** the client stops using that local capability and preserves all workspace data and normal mesh device membership
- **AND** it reports whether service-side revocation is still pending or has been verified.
