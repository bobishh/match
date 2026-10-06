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
- [ ] Run full CI-equivalent verification; `verify:meta-mesh` is blocked by pre-existing tracked changes under `vendor/meta-mesh`.

## Verification record

- `npm run quality`, `npm run test:coverage`, `npm run quality:size`, `npm audit --audit-level=moderate`, and `npm run verify:policy` pass. Coverage: 101 files; 916 passed, 1 skipped; all thresholds pass.
- Focused corrected Playwright cases pass, including filtered-board 7/7 and performance/recovery 7/7. Earlier full core run reported 226 passed and 33 failed; all 33 failures later passed in focused corrected runs. No fresh full-core aggregate recorded.
- Bounded TLC scenarios pass: 14/14.
- `git diff --check` passes. No remote CI run or deployment performed.
