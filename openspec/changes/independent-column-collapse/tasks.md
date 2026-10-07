# Tasks

- [x] Add OpenSpec behavior specs for independent collapse, archive uniqueness, and timestamped transitions.
- [x] Add model/validation support for board archive reference and column collapsibility.
- [x] Migrate legacy archive flags and item lifecycle timestamps atomically.
- [x] Update column creation/schema commands to preserve archive uniqueness.
- [x] Update item workflow and lifecycle commands to write paired state/time records.
- [x] Replace Archive-only UI collapse with independent per-column controls and local preferences.
- [x] Add unit tests for archive migration, state transitions, and invalid board references.
- [x] Add isolated Playwright happy-path and failure/pending coverage.
- [x] Add and run bounded TLA+ scenarios for invariants and interleavings.
- [ ] Run full CI-equivalent verification; the `vendor/meta-mesh` verification gate now passes, but the current Match run still needs a green rerun after a quality-lint fix.

## Verification record

- Previous local checks passed: `npm run quality`, `npm run test:coverage`, `npm run quality:size`, `npm audit --audit-level=moderate`, and `npm run verify:policy`. Coverage at that point: 101 files; 916 passed, 1 skipped; all thresholds passed.
- Focused corrected Playwright cases pass, including filtered-board 7/7 and performance/recovery 7/7. Earlier full core run reported 226 passed and 33 failed; all 33 failures later passed in focused corrected runs. No fresh full-core aggregate recorded.
- Bounded TLC scenarios pass: 15/15, including identity catalog scope.
- Latest Match Verify run `37570724148` on `71f679f` passed `verify:meta-mesh`, the receive-mutation contract, and `verify:policy`; `npm run quality` failed on an unused preload export. Main fixed the lint issue; rerun remains pending.
- Rusty deployment completed. Match deployment remains pending green CI.
