## ADDED Requirements

### Requirement: Independent automation authority
Automation SHALL own a certified identity distinct from Keeper and the owner. Approval SHALL bind exact writable workspace/board, commands, target columns/fields and authority generation, and disclose actual document-wide read access. No owner root, access management or implicit unrestricted Editor authority SHALL be issued. Clef SHALL provide decisions only.

#### Scenario: Existing card authored with clients closed
- **GIVEN** owner-approved createItem authority for one job board and relay-only Keeper
- **WHEN** automation handles valid intake with all human clients closed
- **THEN** it signs a Lead mutation that an authorized client later validates, without any Keeper application write grant.

#### Scenario: Unapproved workspace
- **WHEN** automation submits a change to an unapproved workspace/board
- **THEN** every receiver rejects it even through an otherwise valid relay.

### Requirement: Receivers enforce semantic command restrictions
Receivers MUST validate actual before/after effects from the proven causal base against delegation. Command labels SHALL NOT establish permission. Missing evidence SHALL remain pending. Derived rank-only effects MUST be confined to the approved board; v1 status moves SHALL target eligible leaf cards.

#### Scenario: Forged move label
- **GIVEN** automation can move a card to Interview
- **WHEN** it signs a change labelled moveEntity that also renames the board or modifies another card narrative
- **THEN** receiver admission rejects the unauthorized effects and visible state remains unchanged.

#### Scenario: Allowed rank adjustment
- **WHEN** an otherwise valid delegated insertion causes existing command logic to renumber siblings
- **THEN** only proven rank-only adjustments inside the approved board are accepted with the insertion.

### Requirement: Transport-independent Worker execution
Preferred automation SHALL execute policy/Automerge through a workerd-compatible entry point and publish ciphertext using negotiated HTTPS. Browser/native transport requirements SHALL NOT be assumed compatible. A measured fallback MUST remain an independent automation peer with identical access restrictions.

#### Scenario: Browser APIs unavailable
- **GIVEN** workerd has no browser WebRTC/IndexedDB
- **WHEN** automation authors an approved board command
- **THEN** it uses transport-free policy, durable service state and HTTPS without initializing browser transport.

### Requirement: Durable replay-safe execution
Automation SHALL serialize authoring through one fenced coordinator per writable workspace, namespace event/job/card IDs and atomically persist document changes, proofs, action receipts and exact pending encrypted outbox bytes. At-least-once delivery SHALL NOT create duplicate logical actions.

#### Scenario: Crash after remote commit
- **GIVEN** Keeper committed an object but automation lost its receipt
- **WHEN** the event is retried
- **THEN** the exact prepared object is republished and one logical card/move/evidence record remains.

#### Scenario: Concurrent consumers
- **WHEN** two consumers process the same source event
- **THEN** their shared workspace coordinator records one action under the active fenced generation.

#### Scenario: Distinct identical submissions
- **WHEN** independent accepted submissions contain identical text
- **THEN** they retain distinct event identities instead of being collapsed solely by body hash.

### Requirement: Revocation is independent from storage
Receivers MUST enforce monotonic automation authority revocation and key epochs independently from Keeper relay rights.

#### Scenario: Revoked automation routes around Keeper
- **GIVEN** a receiver has installed automation revocation
- **WHEN** that identity forwards a stale-generation change through another peer
- **THEN** it cannot regain write authority, while the owner's authorized encrypted storage continues.
