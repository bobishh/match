# Code quality audit

Snapshot: 2026-09-21.

Goal: make code-quality checks deterministic and keep every gate at zero without
rule suppression, threshold weakening, generated baselines, or compressed code.

## Final status

| Gate | Initial result | Final result |
| --- | ---: | ---: |
| TypeScript / Vue | pass | pass |
| ESLint | 255 errors | 0 errors |
| Knip | unused files, exports, and types | 0 findings |
| dependency-cruiser | 1 boundary warning | 0 violations |
| jscpd | 10 clones / 115 lines / 0.44% | 0 clones / 0.00% |
| ast-grep project rules | 5 ignored persistence promises | 0 findings |
| Vitest | 531 tests | 543/543 tests, 51 files |
| Playwright core | not run as one gate | 100/100 tests |
| npm audit | 2 moderate development findings | 0 vulnerabilities |
| initial JavaScript | 220.58 / 225 kB Brotli | 206.25 / 225 kB Brotli |
| application CSS | 9.38 / 10 kB Brotli | 9.17 / 10 kB Brotli |
| Automerge WASM | 781.44 kB / 1.1 MB Brotli | 781.44 kB / 1.1 MB Brotli |
| mesh WASM | 2.02 / 2.1 MB Brotli | 2.02 / 2.1 MB Brotli |

The original 255 ESLint errors were:

1. 90 explicit `any` uses;
2. 53 unused variables;
3. 51 complexity-limit breaches;
4. 20 empty blocks;
5. 12 oversized functions;
6. 10 files over 500 lines;
7. 9 statement-limit breaches;
8. 8 excessive-depth breaches;
9. 2 minor correctness/style findings.

All categories now report zero. Production `any` was not mechanically renamed to
`unknown`: network, storage, command, schema, and WebMCP inputs now validate and
narrow into concrete domain types at their boundaries.

## Installed deterministic tools

Versions are pinned in `package.json` and `package-lock.json`.

| Tool | Purpose | Configuration |
| --- | --- | --- |
| `vue-tsc` | Vue-aware TypeScript checking | `tsconfig.app.json` |
| ESLint 10 + typescript-eslint + eslint-plugin-vue | correctness, type-aware async checks, `any`, unused code, objective complexity/size limits | `eslint.config.js` |
| Knip | unused files, exports, types, dependencies, unresolved imports | `knip.json` |
| dependency-cruiser | cycles and layer boundaries | `.dependency-cruiser.cjs` |
| jscpd | token-based code clones in TS, Vue, and CSS | `.jscpd.json` |
| ast-grep | repository-specific forbidden patterns | `sgconfig.yml`, `quality-rules/` |
| Size Limit | Brotli budgets for initial JS, CSS, and WASM | `.size-limit.json` |
| Vitest 4.1.11 | unit and contract tests | `vite.config.ts` |
| Playwright | outer user-visible BDD | `playwright.config.ts`, `e2e/` |

`vitest` was upgraded from the vulnerable 3.x line to 4.1.11. `npm audit`
reports zero vulnerabilities.

## Structural work completed

### Application shell

`src/App.vue` fell from 1668 to 462 lines. Startup, access policy, mesh state,
board projection/dragging, and actions moved into focused modules under `src/app/`.
The browser suite covers drag/drop success, persistence rollback, keyboard/focus,
mobile navigation, archive undo, pending saves, and startup states.

### State, storage, and commands

- `src/state.ts` is a 10-line facade over typed state modules.
- legacy storage, raw IndexedDB, journal, and repository behavior are separated;
- duplicate bundle-v2 code and fire-and-forget compatibility APIs are gone;
- `src/domain/commands.ts` is a 74-line dispatcher over typed handlers;
- `createBoard` reuses `seedBoard`, including preset columns, fields, and bindings;
- persistence promises are awaited and the command switch remains exhaustive.

### Device sync and durable mesh

- `src/sync/useDeviceSync.ts` is an 8-line facade over explicit controller,
  host, enrollment, guest, state, and view modules;
- `src/sync/durableMesh.ts` is a 4-line facade over authority, credentials,
  membership, dialing, handshake, session, gossip, succession, and recovery layers;
- optional `group?.publish()` was replaced with an initialized host invariant;
- workspace create persists local ownership before network availability;
- workspace deletion leaves only the selected workspace mesh instead of closing
  and restarting the global sync runtime.

### Schema UI and WebMCP

- `SchemaEditorDialog.vue` fell from 869 to 401 lines; editor sections live under
  `src/components/schema-editor/` with shared typed draft state;
- stale `conflictNotice` state and dead selectors are gone;
- WebMCP registration is table-driven and schemas, parsing, and contracts share
  typed sources instead of parallel `any` payloads.

### Modal runtime

The magic 250 ms handoff timeout is gone. Scroll lock now follows actual Vue leave
DOM lifetime. A background observer re-applies `inert` to branches inserted while a
modal is open. Nested focus return, drawer-to-dialog handoff, dynamic background,
Escape, reduced-motion, and mobile scroll lock have browser coverage.

## Sync/runtime defects fixed

### BigInt gossip timer

`expireTimer` now accepts a `bigint`; serialized timer IDs are converted once with
`BigInt(timer.timerId)` before entering the Rust/WASM boundary. Vendor gossip tests
cover the value and pass 12/12.

### Offline stale route

`All routes failed for device …` is classified as a retryable network condition.
A losing/superseded route cannot overwrite a healthy incoming session diagnostic.
When every route is offline, UI remains in reconnecting state instead of presenting
a hard sync-integrity failure.

### Local hydration before mesh runtime

`state.ts` no longer statically imports Iroh or durable mesh. Local IndexedDB state
hydrates first. Durable mesh and Iroh load through dynamic imports only when sync
starts. This removed the static/dynamic import conflict and reduced initial JS from
220.58 to 206.25 kB Brotli.

Local authority checks no longer call the Rust runtime before mesh startup.
Ownership-transfer conflict detection is pure TypeScript with the same key:
`(epoch, fromOwnerPersonId) -> distinct toOwnerPersonId`.

## Commands

```text
npm run quality:types
npm run quality:lint
npm run quality:dead
npm run quality:deps
npm run quality:dup
npm run quality:patterns
npm test
npm run quality:size
npm run test:e2e
npm audit
```

Recommended CI order: types, lint, dead code, dependency boundaries, duplication,
project AST rules, unit tests, build/size budgets, browser BDD, security audit.

The `quality` script now runs all static gates in that order. CI executes it,
unit tests, build/size budgets, and the security audit before its existing core
and network browser jobs. The persistence AST rule has positive/negative fixtures
and fails the build; dependency boundary violations also fail instead of warning.

Final verification caught a sync regression: document merging was accidentally
short-circuited when no new signatures arrived. Validated document merging now
runs independently of proof changes; the existing same-ID workspace preservation
regression test passes again. Proof-only changes still notify the live mesh.

## Remaining budget risk

No gate is failing. Two budgets remain intentionally tight and should be ratcheted
only after real dependency/runtime work:

- CSS: 9.17 of 10 kB Brotli;
- mesh WASM: 2.02 of 2.1 MB Brotli.

Vite still warns that the raw initial JavaScript chunk exceeds 500 kB. The formal
initial-transfer gate uses Brotli and has 18.75 kB headroom. Further reduction should
split application features, not raise the limit.
