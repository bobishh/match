# Item transitions

## Requirements

### Requirement: Workflow changes have one paired value and timestamp
An item workflow transition MUST store destination column ID and change timestamp together. Placement MUST agree with destination column.

#### Scenario: Move item between workflow columns
- GIVEN active item is in column A
- WHEN command moves item to column B
- THEN placement and workflow destination both become B
- AND workflow change timestamp advances in the same workspace change

### Requirement: Lifecycle is distinct from workflow
An item lifecycle MUST record active or archived state with its change timestamp. Archive and restore MUST preserve workflow destination and timestamp.

A valid lifecycle transition MUST be authoritative over legacy `archivedAt`; the legacy field is migration input and fallback only when no valid transition exists.

#### Scenario: Archive and restore item
- GIVEN active item has workflow destination B
- WHEN item is archived and later restored
- THEN lifecycle changes to archived and back to active with transition timestamps
- AND workflow destination remains B throughout

#### Scenario: Active lifecycle overrides legacy archive timestamp
- GIVEN an item has a valid active lifecycle transition and a legacy `archivedAt` value
- WHEN archive state is read
- THEN the item is active

#### Scenario: Failed save does not publish transition
- GIVEN archive command cannot persist
- WHEN command fails
- THEN observable lifecycle value and timestamp remain unchanged
