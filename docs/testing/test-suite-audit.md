# Test suite audit — 2026-10-02

## Baseline and limits

Before reduction, core contained 176 independently expanded scenarios. The inventory [core-scenarios.tsv](core-scenarios.tsv) now tracks the current suite. The earlier statement that CI passed 179 scenarios was incorrect: log numbering included retries. GitHub run `36991147079` was cancelled at its ten-minute job limit, before Playwright printed the final failure report.

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

## Follow-up: consolidate setup into user stories

Requested scope: audit repeated preparation and propose multi-action, multi-card and multi-user histories. This section changes no executable tests. A shard splits existing tests between separate runners; it reduces elapsed time by parallelism, not repeated work. Story consolidation addresses the repeated work.

### Measured cost

Source: the two successful local CI-mode JSON reports for commit `4f690a0` (`/tmp/match-core-shard-1.json` and `/tmp/match-core-shard-2.json`). Durations below sum test attempts per file; they are not elapsed CI time, isolated setup measurements, or predicted savings. All 176 scenarios passed without retries in these reports.

| Group | Scenarios | Summed local test seconds |
| --- | ---: | ---: |
| Filtered board layout | 8 | 22.8 |
| Workspaces | 13 | 21.2 |
| Detailed-card performance | 3 | 16.3 |
| Board drag/drop | 8 | 16.0 |
| Card narrative races | 4 | 10.6 |
| Interaction polish | 9 | 10.2 |
| Workspace worker admission | 4 | 10.0 |
| Remaining UI polish | 9 | 10.0 |
| Inline add | 2 | 8.9 |
| Configured workspace creation | 6 | 8.9 |

Static searches across all spec files found 189 `page.goto(`, 87 `.reload(`, 43 `.newContext(`, and 96 `.newPage(` call sites. These include helper bodies and loops: they are not runtime counts or evidence that every call is wasteful. Explicit `waitForTimeout` has eight call sites; touch gesture timing accounts for some. There is no evidence that removing sleeps alone solves suite cost.

### Concrete consolidation map

Each proposed story owns fresh state and named `test.step` phases. Share setup **within** a story, never mutable pages between independent tests. Use several named cards so failure, restoration and successful edits do not accidentally assert against the same ambiguous locator. Every fault injection must be restored and recovery asserted before a later phase.

| Current source and repetition | Proposed story | Assertions that must survive / boundary |
| --- | --- | --- |
| `filtered-board-layout.spec.ts`: eight calls to `createBoard`, each creates a board, adds an Owner field through JSON and saves three cards through UI | Desktop filter story: one-column status + context + overview → close → two-column search/geometry → empty result → reset → filtered move with preview → hidden card survives → reload. Mobile layout story remains separate. Failed drag → recovery can be one fault story. Refresh-during-drag and the two cancellation directions remain targeted race probes. | Preserve desktop width, context widths/opacity, mobile navigation absence, hidden-card count, exact source/destination and ghost cleanup. Clear filters and close dialogs between phases. Source-disappears and destination-disappears cancellation are distinct. Do not collapse all eight into one chain. |
| `archive-layout.spec.ts`: identical full flow at 1920, 1440, 1024 and 390px, recreates job board each time | One responsive archive story, loop through all four widths on one board; open/close archive at each width. Add compact/phone boundary and search/reset phases from `board-breakpoint.spec.ts` only with explicit reset of selected column and filters. | Retain six-column geometry, no document overflow, archive colors, expanded equal width, collapsed 76px width, 560/561 navigation boundary and 640px empty/reset. Fresh mobile *touch context* tests are not replaced by resizing a desktop context. |
| `board-drag-drop.spec.ts`: five desktop tests repeatedly create a blank board and cards | One normal desktop ordering story: create three cards → hover/drop into empty column → cross-column order → same-column reorder → column reorder in edit mode → reload final state. Failure/retry is a second story, potentially consolidated with the detailed-card failure probe. | Assert full ordered ID/title arrays at each mutation, empty hint during hover, notices, durable final order. Keep three touch tests separate from pointer story. Keep measured performance isolated from unrelated steps. |
| `workspace-settings-json.spec.ts`: four identical blank-board/dialog setups | One configuration story: invalid entity name → exact validation path → repair → second-archive rejection → repair → apply title/entity/fields/templates + renamed archive → reload. | Disabled Apply must leave committed config unchanged. Prove repaired draft applies all intended fields; current happy test only checks a subset. Required-field value matrices belong in domain unit tests, while UI retains an actionable example. |
| `card-edit.spec.ts`, `card-stage-shortcuts.spec.ts`, `history-restore.spec.ts`, `rejection-notes.spec.ts`: each helper creates board and item anew | Two coherent lifecycles: generic card (create → shortcut → reorder → failed restore → successful restore → reload); job lead (create → edit → rejected → notes → failed save → retry → reload). Several cards exercise neighbor preservation. | Generic versus job-specific forms remain distinct. Slow-save/newer-draft and narrative races retain explicit controlled scheduling in separate probes. Do not replace debounce assertions with merely eventual text visibility. |
| `chat.spec.ts`: paired message/offline history and typing story each perform invitation and owner approval | Extend existing paired chat history with typing/device-count/no-message phase **before** sending. Then send, verify delivery, toast, replay deduplication, offline recovery and private workspace separation. | Existing test already combines many useful behaviors; consolidate the repeated pairing, not remove assertions. Verify typing clears before subsequent phases. Keep local storage/signing and unavailable Markdown faults separately recoverable. |
| `member-access.spec.ts`: already one visitor → editor → revoke → cancelled reconnection → approved reconnection history | Retain as model for coherent multi-step access story. Add actual edit/denied edit verification if replacing overlapping role scenarios. | A promoted visitor does not prove direct editor invitation admission. Preserve direct editor/visitor admission until their different paths are explicitly exercised. Ownership transfer and quorum succession are destructive authority transitions, separate stories. |
| `durable-mesh.spec.ts`: repeated `pairWorkspace` across transport stories | Candidate normal transport history: paired edits → one reload → tab close/return → queued edits → offline edits on both sides → convergence. Fault family remains separate: real node failure, dropped notification, receive persistence failure/no acknowledgement, unsigned change rejected without disconnect. | Reload, closed tab, offline browser, real Iroh node close and lost transport catalog are different recovery mechanisms. Preserve checkpoints/counters per mechanism. Do not treat same final card visibility as equivalence. No network duration estimate: no complete timing report reviewed here. |
| `telemetry.spec.ts`: same startup/send/reload sequence for HTTP 202 and 503 | One diagnostic resilience history with switchable intake status and two distinct message IDs, isolated captured event batches and one final reload. | Await first batch completion before switching status, assert both records/events and content exclusion, recovery queue behavior separately. Persistent retry state may make separate cases cheaper to diagnose; measure before selecting survivor. |

### Wrong layer and scheduling

1. `playwright.config.ts` assigns all of `sync.spec.ts` and `chat.spec.ts` to network projects. Inspection shows many tests there need no paired peer: startup shell, PDF artifact validation, archive/filter layout, desktop/mobile geometry, chat resize, local persistence and local signing failure. Move those cases to core/local stories; leave actual pairing and real delivery in network projects. This removes local work from the 13-project serial network queue without claiming any scenario is redundant.
2. `chat-storage.spec.ts` runs seven real IndexedDB tests but navigates to the full app before importing `ChatStore`. `storage-atomicity.spec.ts` similarly boots the app even for its first two storage-only transaction cases. Use a minimal same-origin browser harness for these cases, following `storage-offline-shape.spec.ts`; preserve real IndexedDB transactions, cross-page behavior and durable reopening. Cases using `useMatch`, signed admission or UI publication still require app boot.
3. Typed fixtures can prepare unrelated layout boards through existing commands/storage rather than repeated form submission. Retain genuine board/card creation and schema editing UI in the lifecycle stories. Generate fresh identities and signed state through supported application APIs; copying only IndexedDB or a browser storage-state file is not an established valid peer fixture. Cached runtime workers, channels and crypto identity make global browser sharing risky.
4. Unit/API checks should own exhaustive combinatorial input validation. Browser stories retain validation messaging, disabled actions, pending state, failure/retry, wiring and persistence. Real browser storage and real transport tests stay at their integration layer rather than being replaced by mock-only unit assertions.

### Assertion audit: concrete overclaims

- `history-restore.spec.ts` second test says “retry works” but only injects failure, checks alert, closes and checks current placement. It never clears the failure or retries. A consolidated history must add recovery and reload before claiming retry coverage.
- `board-drag-drop.spec.ts` cross-column “exact placement persists” test checks only destination visibility; its destination starts empty. The same-column ordering test checks only the first card. Preserve these flows but strengthen full order/count and unaffected neighbors before using them to replace tests.
- `workspace-settings-json.spec.ts` “changes all settings” changes fields and document templates but asserts title, entity label, column and reload label only. Verify configured fields/templates through their user-visible consumers in the configuration story.
- Source-coverage uniqueness cannot reveal these assertion gaps. No conclusion about all 754 unit assertions follows from this limited browser review.

### Execution order for a later reduction pass

1. Resizing/archive and settings validation→repair histories: limited state coupling; retain assertion checklist and compare reports.
2. Filter layout: highest measured local group cost, repeated three-card setup proven in source. Consolidate desktop layout and successful move, keep race branches separate.
3. Minimal browser storage harness and local/network file split: remove irrelevant boot/queue work without weakening behavior.
4. Generic/job card lifecycles and paired typing/chat: named cards/users, explicit recovery and intermediate durable checks.
5. Transport consolidation last: transport state recovery and acknowledgement invariants make broad merged chains risky.

Measure phase setup, execution, retries, total runner seconds and elapsed CI separately. Compare before/after with the same runner configuration and passed-attempt coverage; changed assertion counts and unique risks must be reviewed. No savings target or reduced test count is asserted before a trial run. No scenarios were deleted or merged by this audit.

## Implemented first reduction pass

The follow-up plan above preceded implementation. This pass consolidates coherent histories, not arbitrary independent tests:

- Archive widths: four cases → one story, retaining every width/open/close/geometry/color assertion.
- Compact breakpoint: two cases → one resize/search/reset story.
- Settings JSON: four cases → one invalid→repair→apply→reload story. Added required Author validation/recovery, persisted Author value and template preview checks.
- Desktop filtered layout/search/move: three cases → one story; mobile, failed drag, incoming refresh and both filter cancellation directions remain independent. File total eight → six.
- Desktop ordering: four happy cases → one three-card/card-and-column story. Added full ordered arrays, unaffected neighbors, and durable final column order. Failure remains separate, now includes retry/reload. All three touch cases remain separate.
- History restore: two cases → one failed restore→retry→reload story. Recovery is now actually exercised.
- Seven ChatStore and two storage-only transaction cases retain real browser IndexedDB but use a script-free same-origin harness. Remaining four atomicity cases still boot the application.
- Eight local chat and eight local board/startup cases moved out of the serial network projects into `chat-local.spec.ts` and `board-local.spec.ts`. Paired chat now includes typing before message delivery on the same connection. Its offline, toast, replay and private-workspace assertions remain.

The selected eight-file reduction group went from 41 to 28 scenarios. Serialized uninstrumented runs on the same local machine, one worker, zero retries: **64.946 seconds before; 46.996 seconds after (27.6% shorter)**. Reports: `/tmp/match-story-before-timing.json`, `/tmp/match-story-after-timing.json`. This is one local pair, not a statistical benchmark or a prediction for all CI. Core test count grows when local network-project cases move into it; total count reduction and scheduling changes must be distinguished.

### Coverage comparison and collector correction

Initial comparison showed restore handlers disappearing from coverage despite both failure and success assertions passing. Raw Chrome data reported `restoreSelectedItemVersion` and `restoreItemVersion` count zero after reload; the standalone failed case without reload reported a call. Collection now checkpoints before explicit `page.goto` and `page.reload`, retaining old-context counts. Isolated probes confirmed calls survive goto, reload and an early page close after a checkpoint. Closed-page final context remains unavailable; earlier checkpoints survive. These checks were temporary plumbing probes, not extra product scenarios.

Corrected passed-attempt reports: `coverage/story-baseline-corrected/` (41 cases) and `coverage/story-after-corrected/` (28 cases), both with 154 loaded source files. Selected-group line coverage is 61.96% before and 61.44% after. This decrease was reviewed rather than hidden:

- Raw named-function calls lost from the sample are app/mesh teardown and cleanup, consistent with removing full application boot from storage-only cases. They are not asserted cleanup regressions; lifecycle/network tests retain their explicit cleanup behavior.
- Converted source locations also differ for Vue template handlers and field/range filter function bodies. Raw `updateField`/`updateRange` call counts were zero in both groups: the apparent baseline coverage is not evidence these interactions had been tested. Thus source-line attribution alone cannot certify equivalent assertion strength.
- Raw restore handler counts are two before and two after after the checkpoint fix; the new story now proves actual successful retry and durable restoration, unlike the original failure case.
- Added execution includes required-field validation, schema repair, and modal handling. `coverage/story-after-corrected/comparison.json` records converted location differences for review.

No percentages were padded by excluding production files or adding redundant tests. Main-thread sample coverage remains a review aid; assertions, raw counters, real IndexedDB/network checks, and the uninstrumented performance gate provide different evidence.

### CI failure discovered during reduction

GitHub run `37005478976` passed both core shards, verify and native Rust peer, but failed the existing workspace-roles snapshot-preparation failure case twice. The guest retained the injected terminal cause; the owner showed reconnecting with no alert. Local reproduction confirmed generic live recovery cleared the non-network admission error. A scoped `WorkspaceAdmissionFailure` now preserves the host cause while cleaning up and adopting durable mesh; ordinary network and already-admitted session recovery remain unchanged. Existing browser failure plus owner/editor happy flow passed, with unit checks for terminal cause after successful and failed handoff. The failing assertion was retained.

The first full reduced-core run passed 178 cases and failed the relocated Markdown-unavailable chat case after reload. Trace showed board readiness completed before Chat opened: this was not evidence of an empty workspace ID. Its initial text assertion passed on an optimistic pending message, then the test immediately reloaded before signing/storage finished. The scenario now awaits absence of the pending marker before checking durable text and reloading; all eight local chat cases passed twice without retries. No startup/hydration product change was made for this fixture issue.

### Final verification

Final core run: **179/179 passed**, two shards with one worker each, zero retries, alternate ports; shard durations 3.2 and 2.7 minutes. This is local elapsed time, not measured GitHub runner time. Unit coverage run: 756 passed, one skipped across 81 files; lines 51.44%, branches 41.30%, existing global floors passed. Full quality checks and initial JavaScript size gate passed (234.71 kB against 235 kB). Relevant network chat/sync cases passed (8 cases), as did the unchanged workspace-role admission failure and owner/editor happy flow. Full network matrix remains a CI responsibility; these focused runs do not certify every network scenario.

### Follow-up CI measurement isolation

Run 37021109106 passed verify, native peer, and core shard 2, but core shard 1 failed the responsiveness gate (271 ms, retry 239 ms) and second-tab readiness. The latter failed before concurrent writes: the second page still showed “Checking workspace access” after five seconds. It now explicitly awaits startup readiness with the same 15-second budget used for cold detailed-board reload; concurrent write and durability assertions remain unchanged.

Both CPU profiles contain roughly 289 ms cumulative self time in Playwright's `visitNode → captureSnapshot` stack. Cumulative samples cannot attribute the exact longest-task boundary, but show recorder work inside the measurement. Responsiveness now runs in a separate file with trace recording disabled; its CPU profile, 4× throttle, DOM identity checks, cold durability check and 200 ms gate remain. Failed storage/retry and two-tab durability keep failure traces. Optional source coverage also excludes the new performance file. This is measurement isolation, not evidence of a new production performance improvement.


## Interaction hot-path audit and correction

The next run, `37022516078`, still failed both core shards: move long tasks were 250/278 ms despite trace being disabled, and the two-tab case timed out during the final cold reload. Disabling trace alone was insufficient. The measured interval also included role-based accessibility queries, whose Playwright snapshots walked all detailed cards. The move benchmark now uses physical pointer input and CSS checks during measurement, captures long tasks before accessibility assertions, checks board/neighbor DOM identity, then checks durable reopening. The 200 ms budget remains unchanged. Cold detailed-board access checks use 15 seconds; concurrent-write assertions remain intact.

A separate isolated 55-card, 4× CPU probe measured Chat pointer Event Timing at 1064–1112 ms. Its CPU profile showed full Automerge save/load solely to retrieve the chat-room identifier. The audit found additional avoidable work:

- Chat room, owner and attachment metadata now read the authoritative active document directly; inactive workspaces still load durable documents. Actual network snapshot serialization remains.
- Content changes verify active workspace access without reloading every inactive workspace. Catalog, readiness, ownership/authority and identity invalidation still verify the whole catalog. Deferred-result tests cover stale role results and retained access errors.
- Local commands use an exhaustive typed capability map before dispatch rather than canonicalizing and diffing entire documents. Incoming network/import transition validation, ownership checks, command validation and signed change authorizations remain.
- Successful local writes no longer write a second legacy projected workspace. Catalog refresh reads active/archive entries together. Focus reconciliation reuses matching active heads while still replaying later journal changes. Catalog recovery now uses typed helpers; eight obsolete unsafe lint suppressions were pruned, with no new allowances.
- Board presentation indexes notes/leads and children, caches filtered/sorted column arrays, and skips narrative search construction for an empty query. Ancestry follows parent IDs with cycle detection rather than enumerating all entities for each path.
- Restore uses a causal Automerge view at the selected recorded hash rather than replaying full history snapshots. A concurrent-branch regression checks the selected version and retained history; the browser story checks failure, retry and durable compensation.
- Optional settings participants and hierarchy move dialog load on demand. Their loading does not defer Chat or Sync. No feature or bundle threshold was removed.

### Verification evidence

Quiet isolated final timing run, one worker, no trace/coverage, 55 detailed cards, 4× CPU: move longest main-thread task **70 ms**; Chat pointer Event Timing **64 ms**, click-to-dialog paint **64 ms**; Sync Event Timing **40 ms**, click-to-dialog paint **110 ms**. These are different metrics, not interchangeable INP claims. Earlier repeated Chat checks gave 64–72 ms. This is controlled local evidence, not measurement of the user's production workspace or fleet-wide field INP. Chat metadata failure leaves an error and the next card interaction works.

Selected affected browser histories: 47 cases covering access refresh, drag/filter cancellation and incoming refresh, archive, notes/search, restore, storage failure/atomicity, workspace catalog and hierarchy. Forty-six passed in the initial run; one filter case was interrupted by an App.vue hot update visible in its trace, then passed on frozen code. No product assertion was removed for that interruption. All four isolated performance/failure cases passed. Network Chat, Sync, workspace roles and member access passed: 14 cases, including owner/editor/visitor controls, decline, terminal admission failure, promotion and revocation. Controlled paired-chat delivery was 187 ms; this does not diagnose earlier production delivery incidents.

Full local quality checks passed. Unit coverage: 768 passed, one skipped, 85 files; lines **51.58%**, branches **41.43%**, all original floors retained. Initial JavaScript **234.90 kB Brotli** against **235 kB**. Core inventory contains 183 scenarios. A full local core rerun was unnecessary after these focused checks; the existing CI workflow retains the full browser matrix. Remote CI status and deployment are recorded separately from these local results.
