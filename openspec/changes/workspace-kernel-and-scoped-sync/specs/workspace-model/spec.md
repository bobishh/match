## ADDED Requirements

### Requirement: Independent typed workspaces

The system SHALL store each workspace as a separate Automerge document matching `contracts/model.ts`. A workspace SHALL contain boards, columns, tasks, fields, documents, templates, and artifacts as typed records keyed by stable IDs. It SHALL NOT store a second authoritative status/column/board pointer on tasks or an EAV table.

#### Scenario: Another workflow needs no job-search fields

- **GIVEN** a person has a Job search workspace
- **WHEN** they create another workspace using Blank board
- **THEN** it has a distinct UUID and To do, Doing, Done columns
- **AND** a task can be created using only a title and parent
- **AND** neither workspace changes the other's fields or columns.

#### Scenario: Column rename preserves membership

- **GIVEN** a task references an Applied column
- **WHEN** that column is renamed to Sent
- **THEN** its ID and the task's placement remain unchanged
- **AND** the task is shown in Sent after reload.

### Requirement: Stable IDs and explicit containment

The system SHALL allocate UUIDv4 IDs for new mutable content, transactions, and workspaces; preserve legacy record IDs; and validate the parent-kind table in `design.md`. Task nesting SHALL inherit board/column through ancestry. References SHALL resolve only within the containing workspace.

#### Scenario: Task and subtask move together

- **GIVEN** task A contains subtask B in To do
- **WHEN** A moves to Doing
- **THEN** B derives Doing through A without a write to B
- **AND** A and B retain their IDs.

#### Scenario: Invalid move is atomic failure

- **GIVEN** task A contains B
- **WHEN** a command moves A under B, under a field, or into another board/workspace
- **THEN** it returns the corresponding cycle/invalid-parent/cross-board error
- **AND** document heads and placements remain unchanged.

### Requirement: Soft deletion preserves relationships

The system SHALL retain mutable records and links on delete, toggle only the target's `deleted` flag, and compute inherited visibility through containment. It SHALL provide explicit restore and restore-with-move operations. It SHALL distinguish a live Archive column from Trash.

#### Scenario: Delete and restore a populated column

- **GIVEN** a live column contains live A, live subtask B under A, and separately deleted C
- **WHEN** the column is deleted
- **THEN** A, B, and C are hidden from ordinary board/search results without changing their flags or parents
- **WHEN** the column is restored
- **THEN** A and B reappear and C remains deleted.

#### Scenario: Restore under deleted ancestor

- **GIVEN** a deleted task belongs to a deleted column
- **WHEN** the task alone is restored
- **THEN** its own flag is cleared but it remains hidden
- **AND** the result identifies the deleted ancestor and offers restore-with-move.

#### Scenario: Remote creation under deleted column survives

- **GIVEN** two replicas share a live column
- **WHEN** one deletes it while the other creates a task there offline
- **THEN** after merge the new task is preserved and hidden
- **AND** restoring the column reveals that task.

#### Scenario: Non-parent provenance does not cascade

- **GIVEN** a PDF artifact references a writing template
- **WHEN** the template is soft-deleted
- **THEN** the artifact remains visible under its live task
- **AND** the template reference remains inspectable as deleted.

### Requirement: Deterministic recoverable placement

The system SHALL store parent and rank in one placement register and apply rational ordering with ID tie-breaks as specified in `design.md`. It SHALL derive invalid ancestry issues after merge without destructive automatic repairs.

#### Scenario: Concurrent moves preserve one effective membership

- **GIVEN** two replicas move the same task to different columns
- **WHEN** both merge in either delivery order
- **THEN** both show the same parent/rank pair from one complete placement value
- **AND** the task appears at most once
- **AND** the other placement remains inspectable as a conflict.

#### Scenario: Concurrent valid moves create a cycle

- **GIVEN** A and B are sibling tasks
- **WHEN** one replica moves A under B and another moves B under A
- **THEN** all replicas terminate ancestry traversal and identify the same affected entities in Needs placement
- **AND** a normal move to a live column repairs placement without deleting history.

#### Scenario: Concurrent insertions share a rank

- **GIVEN** two replicas insert tasks at the same gap
- **WHEN** changes merge
- **THEN** both tasks remain and sort by rational rank then ID identically
- **AND** another insertion between them succeeds through deterministic sibling renumbering.

### Requirement: Board-owned custom field definitions

The system SHALL support text, URL, date, boolean, bounded number, and single-select fields. Field IDs and select option IDs SHALL remain stable through label changes. Deletion SHALL preserve values. Field type changes SHALL require creating a replacement field.

#### Scenario: Rename and delete a select option

- **GIVEN** a task selects an option by ID
- **WHEN** its label changes
- **THEN** the task shows the new label without a task-value write
- **WHEN** the option is deleted
- **THEN** the old value stays readable with an unavailable marker and cannot be newly selected.

#### Scenario: Field definition changes do not erase data

- **GIVEN** a task contains a numeric value
- **WHEN** bounds are tightened past that value or the field is deleted
- **THEN** its stored value remains unchanged
- **AND** the UI marks an invalid value or hides the deleted field respectively
- **AND** restoring the field reveals the retained value.
