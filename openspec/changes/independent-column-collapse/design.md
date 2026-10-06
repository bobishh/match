# Design

## Domain records

`Board.archiveColumnId` identifies the one lifecycle destination. An explicit `null` means the board has no archive destination and suppresses legacy column markers; when the field is absent, a legacy `column.archive` marker can still identify the destination during compatibility reads. `Column.collapsible` controls only presentation. Neither flag implies the other.

An item stores lifecycle and workflow transitions as JSON scalar records, so each state/value and timestamp pair merges atomically in Automerge. Lifecycle records contain `{ state: "active" | "archived", changedAt }`; workflow records contain `{ columnId, changedAt }`. Workflow placement and the workflow record must agree. Lifecycle transitions never rewrite workflow. Restore switches lifecycle to active and preserves the saved workflow destination. The legacy `archivedAt` field is migration input only; lifecycle is authoritative when present.

## Commands and migration

Column creation and schema updates set the board archive reference in the same transaction as the column. A newly designated Archive column starts collapsible, but role and capability remain separate stored fields and can be changed independently. Removing or changing the archive column updates or clears the reference atomically. Item move commands update placement and workflow transition together. Same-column reorder changes rank only. Archive/restore commands update lifecycle state and timestamp together.

The format migration upgrades format 2 documents and state-less format 3 documents in one workspace change. It converts legacy `column.archive` to the containing board's `archiveColumnId`, and legacy item `archivedAt` to lifecycle state before removing that legacy field. It rejects more than one legacy archive column per board. It sets workflow transition from current parent and legacy `updatedAt` as the best available timestamp. A valid lifecycle record takes precedence over legacy `archivedAt`; the timestamp remains a migration fallback only when no valid lifecycle record exists.

## Presentation

Each collapsible column exposes its own control. Local storage holds a preference map per workspace, keyed by column ID; it is not synchronized. New Archive columns default collapsed when no preference exists. Filters force matching cards visible without overwriting the saved collapse preference.

## Invariants

- A board references zero or one active archive column, belonging to that board.
- A column can be collapsible regardless of archive role.
- Workflow transition column equals item placement parent.
- Workflow value and timestamp change atomically.
- Archive/restore changes lifecycle only and preserves workflow.
- Collapse changes neither membership nor lifecycle/workflow state.
