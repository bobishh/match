# Proposal: Independent column collapse and state transitions

## Why

Archive currently carries two meanings: lifecycle destination and collapsed presentation. The UI has one Archive-only collapse switch, while Rejected remains permanently expanded. Items also use `archivedAt` as a special lifecycle marker, separate from workflow movement.

## Change

- Store column collapse capability independently from Archive identity.
- Keep one board-level archive-column reference; explicit `null` means no archive destination and overrides legacy flags. Migrate legacy column archive flags into the reference.
- Track item lifecycle as an explicit state transition with its change time.
- Track workflow placement changes with a column ID and change time in one transition record.
- Preserve workflow placement while archiving and restore it unchanged.
- Keep collapse preferences local to the viewer, scoped by workspace, and keyed by column ID.

## Compatibility

Upgrade format 2 documents and state-less format 3 documents by deriving the board archive reference from its single flagged column and deriving lifecycle timestamps from `archivedAt`. Reject ambiguous multiple archive columns. Keep migration atomic in one workspace change.

## Validation

Check board and command invariants in unit tests, UI behavior in isolated Playwright, and bounded transition scenarios with TLC.
