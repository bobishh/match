# Test suite audit — 2026-10-02

## Baseline and limits

Core contains 176 independently expanded scenarios. Inventory: [core-scenarios.tsv](core-scenarios.tsv). The earlier statement that CI passed 179 scenarios was incorrect: log numbering included retries. GitHub run `36991147079` was cancelled at its ten-minute job limit, before Playwright printed the final failure report.

That log already showed five distinct failing cases: detailed-card performance/durable reload, mobile device-list scrolling, fast-startup loading indicator, and telemetry with HTTP 202 and 503. The performance measurements themselves were 168 and 190 ms, below the unchanged 200 ms gate; failure occurred after that measurement. Cancellation must not be presented as the only issue.

Unit coverage is a separate scope. It cannot justify deleting browser tests: it does not execute Vue or prove focus, layout, drag/drop, persistence wiring, or network delivery. Per-scenario main-thread JS coverage is supporting evidence only; identical execution can still assert different outcomes. CSS, Workers, WASM, extra browser pages, and the uninstrumented performance benchmark need behavioral review.

The complete local baseline in CI mode took 354 seconds: 172 clean passes, three failures (fast-startup indicator and both telemetry cases), and one authority-isolation case passed only after retry. Follow-up evidence identified fixture and configuration problems, not redundant assertions:

- Workspace creation helper returned immediately after clicking Create. An owner badge from the previous workspace could satisfy the next assertion; the test then corrupted the wrong workspace. It now waits for the closed form and the new workspace board.
- Permission validation showed its loading indicator immediately, bypassing the existing progress delay. The same delay now covers access checks; card aging helpers moved out of the oversized root component without raising its size limit.
- Diagnostics tests depended on an ignored developer environment variable. Playwright now supplies an intercepted test-only intake URL.
- The performance gate remained below 200 ms in the failing GitHub attempts. CPU slowdown now ends before the separate cold-reload durability check; the performance threshold is unchanged.
- Mobile device scrolling injected a synthetic list and guessed a Vue scope attribute. It now mounts the actual dialog with device data, retaining scroll-lock assertions.

A 15-scenario browser coverage sample was collected for mobile navigation, favicon, compact breakpoint and storage cases. In that selected group, the normal-storage smoke and middle-width navigation had no uniquely executed JS statements. The compact breakpoint boundary scenario had six. The failed-startup favicon case had no collected application module, so its contribution is marked unavailable rather than redundant. Assertions, layout and failure semantics still determine any deletion.

## Candidates for the next reduction pass

No scenarios have been deleted in this audit. These are reviewed candidates, not automatic deletion decisions.

| Candidate | Action to evaluate | Coverage retained elsewhere / unique risk to preserve |
| --- | --- | --- |
| `mobile-nav.spec.ts`: full 390px drawer flow | Keep full flows at 360px and 430px; reduce middle width to geometry smoke if needed | All three execute the same assertion sequence. Preserve smallest/largest widths, focus/inert behavior, Settings handoff, backdrop and Escape. |
| `favicon.spec.ts`: successful startup icon case | Remove only if the failed-startup case retains identical SVG pixel/decode checks | Both call the same `faviconLoads` assertions. The failure case also proves independence from app startup. |
| `storage-upgrade-block.spec.ts`: normal-storage startup smoke | Merge/delete generic smoke | Blank-startup and owner-after-reload flows already assert functional controls; preserve every legacy upgrade, blocked open, conflict, and recovery scenario. |
| `storage-failure.spec.ts`: basic item-save failure | Fold checks into mobile failure/retry flow in `interaction-polish.spec.ts` | Preserve exact alert, draft, no published card, retry, exactly one item, save-state recovery, durable reload. Basic test has less behavior, but viewport is a distinct consideration. |
| `board-drag-drop.spec.ts`: basic failed card move | Consolidate with detailed-board failure/retry in `card-move-performance.spec.ts` | Preserve source placement, empty destination, failure notice, retry and durable reload. Keep filtered-board failure separately: hidden cards/ghost cleanup are distinct. |
| `board-breakpoint.spec.ts`: compact search/reset case | Fold empty/reset assertions into the existing 640→560→561 boundary flow | Preserve compact geometry and no phone navigation at 640px; desktop/mobile filter tests cover different layout branches. |

Expected savings from these candidates are modest. They do not explain all runtime and cannot replace CI isolation. Core now has two independent shards, each with one worker; failed shards upload traces. Network suites keep their existing isolation.

## Keep: distinct risks

- Pointer drag versus touch scroll, release over a header, exact rank/order after reload, and column reordering.
- Filtered versus unfiltered moves, incoming refresh during drag, filter cancellation, ghost cleanup, unaffected DOM, storage failure/retry.
- Atomic IndexedDB commit versus UI publication, migration versus upgrade blocking, overlapping peer admission versus same-device tab contention.
- Owner/editor/visitor roles, forged evidence, revocation, pending authority, offline recovery, durable acknowledgement, and replay.
- Required-field UI validation versus domain validation: keep one meaningful UI example; move exhaustive value matrices to unit tests where appropriate.
- Modal focus traps, inert background, scroll lock and interrupted handoff: source coverage alone cannot establish those outcomes.

## Cost observations

The interrupted GitHub log recorded roughly 30 seconds in filtered-board layout, 27 seconds in drag/drop, and 26 seconds in workspace flows, counting only passing attempts captured in the log. Retries, setup, polling, cold worker startup, and tests not reached are excluded. These are partial observations, not complete suite timings.

Several layout tests create/configure a board and multiple cards through the UI for every assertion. Faster fixture preparation is a candidate after retaining at least one end-to-end creation flow. Removing assertions is not the first response to expensive repeated setup.

## Reduction protocol

1. Collect passed per-test browser coverage for the candidate and proposed survivors.
2. Record assertions and unique user-visible failure each protects; inspect branches, layout, and side effects that JS coverage misses.
3. Delete/merge one reviewed candidate group; compare execution coverage and retain required unique assertions.
4. Run survivors with happy plus failure/pending state; verify durable reload and affected network paths where applicable.
5. Measure actual runtime savings. Keep the change only if protection remains meaningful.

Final local verification retained all 176 core scenarios: both 88-case CI-mode shards passed with no retries (154 and 131 seconds in the recorded runs). Authority isolation passed five consecutive repetitions. Owner/editor and owner/visitor network scenarios also passed. Unit coverage ran 754 passing tests with one skip; static quality, bundle budgets and dependency audit passed. Negative probes confirmed fresh unsafe `any` fails lint and an unmet coverage floor fails the test command. The optional browser collector also passed early-page-close teardown verification without changing the scenario result.
