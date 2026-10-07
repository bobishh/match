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
- [ ] Run full CI-equivalent verification. Match run `37577926234` for `9df48e776fb53792ed0b1089db33191bbc171bea` completed with failure: formal, verify, native, policy, all four core shards, and 12 network projects passed; `scoped-sync` failed on an expired-invitation fixture. Corrected fixture passes focused 1/1 but is not in this run. Full green verification remains pending.

## Verification record

- Previous local checks passed: `npm run quality`, `npm run test:coverage`, `npm run quality:size`, `npm audit --audit-level=moderate`, and `npm run verify:policy`. Coverage at that point: 101 files; 916 passed, 1 skipped; all thresholds passed.
- Focused corrected Playwright cases pass, including filtered-board 7/7 and performance/recovery 7/7. Earlier full core run reported 226 passed and 33 failed; all 33 failures later passed in focused corrected runs. No fresh full-core aggregate recorded.
- Bounded TLC scenarios pass: 15/15, including identity catalog scope.
- Prior Match run `375718` had 14/20 checks pass and 6 failures. Current run `37577926234` has one scoped-sync fixture failure; no fresh full green run recorded yet.
- Rusty deployment completed. Match deployment remains pending green CI.
