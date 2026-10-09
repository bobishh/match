## ADDED Requirements

### Requirement: Triggers use typed stable document slices
A trigger SHALL reference data through a versioned typed selector over stable workspace, board, entity, column and field IDs. Selector predicates SHALL come from a finite validated language with explicit cardinality and byte limits. Array positions, raw Automerge pointers, arbitrary JSONPath, executable callbacks and untyped document mutation paths MUST NOT grant access.

#### Scenario: Resolve stable IDs after reordering
- **GIVEN** an approved selector names a stable board and field ID
- **WHEN** a user reorders columns or fields without deleting the referenced IDs
- **THEN** the selector continues to identify the same semantic data.

#### Scenario: Missing or changed schema
- **WHEN** a referenced field is deleted, changes to an incompatible type, or the selector returns too many matches
- **THEN** the trigger pauses for repair or review
- **AND** it does not broaden to another field or target.

#### Scenario: Reject raw paths
- **WHEN** a trigger definition contains an array offset, arbitrary pointer, unknown predicate or executable expression
- **THEN** validation rejects it before approval or execution.

### Requirement: Approval bounds projection and effects
Owner approval SHALL bind an immutable trigger version/hash, source, workspace, selector, exact read projection and limits, exact operation schemas and target IDs, policy version, expiry and monotonic authority generation. The decision runtime SHALL receive only the resolved typed projection and source evidence required by the trigger. Clef or another model SHALL NOT grant authority.

#### Scenario: Minimal projection delivery
- **GIVEN** a trigger approves company and role fields but not notes, chat or attachments
- **WHEN** the runtime evaluates its condition and decision
- **THEN** it receives only the approved bounded fields and necessary event evidence
- **AND** excluded data is neither decrypted into the trigger input nor sent to inference.

#### Scenario: Current broad-read adapter
- **GIVEN** the runtime can only activate a whole-workspace snapshot
- **WHEN** an owner reviews trigger permissions
- **THEN** the UI states that workspace-wide read access is being disclosed
- **AND** narrow-projection approval remains unavailable until the projection boundary is implemented and verified.

#### Scenario: Trigger edited after approval
- **WHEN** any selector, projection, source, operation, target, threshold or limit changes
- **THEN** the trigger receives a new immutable version and requires owner approval before it becomes active.

#### Scenario: Model asks for a broader mutation
- **WHEN** a model response proposes an operation or field outside the approved trigger schema
- **THEN** the proposal is rejected or sent to review without changing the workspace.

### Requirement: Board commands are exact and receiver-enforced
Version 1 SHALL authorize only `createLead` into the approved Lead column with approved fields, `moveAppliedToInterview`, and `moveAppliedToRejected` for one uniquely matched eligible leaf item from Applied. Moves SHALL retain stable item identity and human-authored narrative. Rejected SHALL be a status column and never archive/delete. Every receiver SHALL validate actual effects against the signed grant and proven causal base.

#### Scenario: Create a permitted Lead
- **GIVEN** an active owner-approved trigger with `createLead` and specific field IDs
- **WHEN** a qualifying event passes policy
- **THEN** automation creates one item in the approved Lead column with only those fields
- **AND** a receiver independently admits the signed change.

#### Scenario: Move Applied application
- **GIVEN** a uniquely correlated eligible leaf item in Applied and an approved move operation
- **WHEN** unambiguous interview or rejection evidence satisfies the approved policy
- **THEN** the same item moves to its stable Interview or Rejected column
- **AND** rejected status does not archive it or replace its human narrative.

#### Scenario: Unauthorized side effect
- **WHEN** a signed command also edits an unapproved field, changes the board schema, moves another item, archives the target or crosses boards
- **THEN** receiver admission rejects or quarantines the whole unauthorized effect before visible state changes.

### Requirement: Commands bind current state and causal evidence
Before external classification, automation SHALL capture the candidate identity, current status/placement revision and causal frontier. Before authoring it SHALL resynchronize and compare those values. The signed command SHALL carry the expected state and source event evidence; receiver admission SHALL repeat the check against the proven causal predecessor. Wall-clock timestamps alone SHALL NOT establish causal precedence.

#### Scenario: Human changes target during inference
- **GIVEN** a trigger captured an Applied item before inference
- **WHEN** a human moves or edits the relevant workflow state before command authoring
- **THEN** automation leaves the board unchanged and sends the event to review.

#### Scenario: Concurrent disconnected branch
- **GIVEN** a human move and an automation move are causally incomparable
- **WHEN** a receiver later reconciles both branches
- **THEN** the receiver preserves the human and automation evidence without silently selecting an outcome
- **AND** any resolution is a new authorized command from current accepted state.

#### Scenario: Stale forwarded email
- **WHEN** a forwarded message timestamp predates the target workflow or conflicts with captured causal state
- **THEN** the status does not move and the event remains reviewable.

### Requirement: Execution is durable, idempotent and auditable
Accepted events SHALL have namespaced stable event IDs; content hash alone SHALL NOT collapse distinct submissions. Trigger actions SHALL have stable job/action IDs, separate retry attempt IDs, a per-workspace fenced coordinator and an append-only encrypted audit record. Prepared ciphertext SHALL be persisted before upload and retried byte-for-byte after uncertain delivery. An event SHALL report applied only after authorized local commit and required remote durable receipt.

#### Scenario: Duplicate source event
- **WHEN** the same source event and trigger version are delivered more than once
- **THEN** the system returns its recorded result and creates no duplicate item, move or evidence.

#### Scenario: Distinct identical submissions
- **WHEN** two different accepted source event IDs have identical text
- **THEN** they remain distinct events and follow normal policy without hash-only deduplication.

#### Scenario: Lost upload response
- **GIVEN** Rusty committed the prepared encrypted object but the response was lost
- **WHEN** the coordinator retries
- **THEN** it republishes the identical object and records one logical action after validating the receipt.

#### Scenario: Crash before and after persistence
- **WHEN** the process stops before durable acceptance or after storing a pending event
- **THEN** it never acknowledges an unpersisted event, and it resumes a stored event using its original IDs and immutable decision/action state.

#### Scenario: Audit inspection
- **WHEN** an authorized owner inspects an event
- **THEN** the record links source identity, trigger version, projection hash, policy/model version, precondition, command, receipt and result without exposing secrets in ordinary logs.

### Requirement: Trigger lifecycle and revocation are monotonic
Triggers SHALL expose draft, approved, active, paused, needs-review, revoked and expired states. Revocation SHALL advance a signed monotonic generation that coordinators and receivers enforce. Replayed old approvals cannot restore authority. Revocation stops future execution but SHALL NOT promise deletion of plaintext or keys already delivered.

#### Scenario: Revoke during retry
- **GIVEN** a prepared action is pending when its trigger is revoked
- **WHEN** a worker retries it under an older generation
- **THEN** the coordinator and every receiver reject new application of the revoked action while preserving its audit state.

#### Scenario: Replay through another relay
- **GIVEN** a receiver has accepted a higher revocation generation
- **WHEN** an old automation change arrives through another valid relay
- **THEN** it cannot regain write authority.

#### Scenario: Revocation and retained copies
- **WHEN** an owner revokes a trigger after data was delivered to an authorized runtime
- **THEN** future reads/writes are blocked according to the new generation
- **AND** the UI does not claim that prior plaintext or keys were remotely erased.
