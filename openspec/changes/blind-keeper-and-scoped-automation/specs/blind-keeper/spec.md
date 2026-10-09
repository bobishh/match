## ADDED Requirements

### Requirement: Blind storage is an independent capability
The system SHALL negotiate a versioned blind-storage mode with dedicated relay authorization. A blind Keeper SHALL NOT receive document content keys, readable workspace invitations, application Editor grants or plaintext command execution responsibilities.

#### Scenario: Owner pairs storage only
- **GIVEN** an owner approves exact documents and the operator approves the same transcript
- **WHEN** blind storage provisioning completes
- **THEN** Keeper receives ciphertext and relay policy only, while automation access remains absent.

#### Scenario: Legacy service
- **WHEN** a service only supports legacy plaintext replication
- **THEN** the client labels it a trusted replica and refuses blind activation or automatic plaintext fallback.

### Requirement: All stored application content is encrypted
Clients and automation peers SHALL encrypt document changes, authenticated snapshots, chat and attachments before sending them to blind Keeper. Envelopes MUST cryptographically bind routing, type, epoch and ciphertext integrity. Keeper SHALL operate on bounded immutable opaque objects rather than decrypting or merging Automerge content.

#### Scenario: Restarted Keeper exposes no content
- **GIVEN** documents, chat and attachments containing unique plaintext sentinels
- **WHEN** Keeper stores them and restarts
- **THEN** its application storage/logs contain no content keys or plaintext sentinels, and an authorized second client reconstructs the content.

#### Scenario: Ciphertext substituted across documents
- **WHEN** ciphertext or its document/type/epoch binding is modified
- **THEN** the receiver rejects it before visible state changes.

### Requirement: Receivers enforce original author authority
Every decrypting receiver MUST verify original author/device evidence and applicable document authority before admission regardless of transporting peer. Storage receipts SHALL NOT substitute for application authorization or causal completeness.

#### Scenario: Forgery forwarded by valid Keeper
- **GIVEN** Keeper has durably stored a signed outer object with an unauthorized inner board change
- **WHEN** another client receives that object through Keeper
- **THEN** the board remains unchanged and the unauthorized change is rejected.

#### Scenario: Missing dependencies
- **WHEN** a valid decrypted change lacks necessary causal history
- **THEN** it stays pending until validated dependencies arrive, without publishing partial application state.

### Requirement: Durable receipts cover exact ciphertext
Keeper SHALL issue authenticated receipts only after durable object commit. Receipts MUST bind service identity/device, nonce, integration/document, key epoch, policy revision and exact ciphertext hashes. Clients SHALL distinguish encrypted storage confirmation, content validation and missing chat/blob coverage.

#### Scenario: Failed save
- **WHEN** persistence fails after upload
- **THEN** no success receipt is emitted and clients show pending or failed storage.

#### Scenario: Lost response and replay
- **GIVEN** an upload committed but its response was lost
- **WHEN** the sender retries identical object bytes and identity
- **THEN** storage remains idempotent and a matching receipt can be returned; a receipt for another nonce/scope/object cannot confirm the current request.

### Requirement: Revocation and migration fail closed
The system MUST apply monotonic authority/key generations, rotate future-content keys after reader removal and reject stale unauthorized writes after learning revocation. Migration SHALL preserve local history and pending events and require encrypted coverage plus independent recovery before retiring legacy access. Historical plaintext erasure SHALL NOT be promised.

#### Scenario: Revoked writer uses another relay
- **GIVEN** a receiver has installed the writer's revocation generation
- **WHEN** that writer submits a stale-generation change through a different relay
- **THEN** the change cannot regain authority through its transport identity; ambiguous offline history follows the documented quarantine policy.

#### Scenario: Migration interrupted
- **WHEN** migration stops before encrypted coverage and second-client recovery complete
- **THEN** it remains visibly incomplete, resumes idempotently and never reports the old trusted host as blind.
