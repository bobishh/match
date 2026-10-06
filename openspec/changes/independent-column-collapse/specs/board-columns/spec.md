# Board columns

## Requirements

### Requirement: Collapse capability is independent from archive role
Each column MAY be collapsible independently of whether it is the board's archive destination. Archive and non-archive columns MUST use the same collapse interaction when enabled.

#### Scenario: Rejected and Archive collapse independently
- GIVEN board has collapsible Rejected and Archive columns
- WHEN viewer collapses Rejected
- THEN Archive remains open and both columns retain their own local preferences
- AND item membership and lifecycle remain unchanged

#### Scenario: Filters temporarily reveal matching cards
- GIVEN a collapsible column is locally collapsed
- WHEN an active search or filter matches a card in that column
- THEN matching card is visible while the filter is active
- AND clearing the filter restores the saved collapsed preference

### Requirement: Board has at most one archive destination
A board MAY reference one active column as its archive destination. The destination MUST belong to that board. Column schema updates MUST preserve this invariant atomically.

When `archiveColumnId` is present, its value is authoritative. Explicit `null` MUST mean no archive destination and MUST suppress legacy column archive markers.

#### Scenario: Reject duplicate archive destination
- GIVEN board already has archive destination
- WHEN command marks a second column as archive destination
- THEN command fails without changing either column or the board reference

#### Scenario: Explicitly clear legacy archive marker
- GIVEN a legacy column has an archive marker
- WHEN the board has `archiveColumnId` set to null
- THEN no column is treated as the archive destination

#### Scenario: Migrate legacy archive marker
- GIVEN legacy document has one flagged archive column
- WHEN format migration runs
- THEN board reference points to that column and legacy marker is removed

#### Scenario: Reject ambiguous migration
- GIVEN legacy document has multiple flagged columns on one board
- WHEN migration runs
- THEN migration fails without publishing a partial document
