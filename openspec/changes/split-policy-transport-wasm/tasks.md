# Split policy WASM from transport

Status: implemented and locally verified on 2026-10-06.
Implementation responsibility: Luna for MetaMesh packaging; Codex for integration,
verification and release. Changes were built in a clean worktree so concurrent
causal-admission/coownership work was excluded.

Local board access currently requires downloading a WASM artifact that also
contains transport bindings. Reordering hydration cannot remove that dependency.
Keep Rust policy validation required for local reads and writes; load transport
only when a network operation needs it.

## Tasks

- [x] Write outer Playwright BDD scenarios on real application routes before implementation: given persisted authorized local data, when transport assets are blocked and the app reloads, then the board opens and a local edit survives reload without requesting transport assets.
- [x] Add failure/pending coverage: when a sync action needs blocked transport assets, then show a recoverable sync failure or pending state while local board access remains usable; retry after restoring assets must sync successfully.
- [x] Inventory startup policy exports and transport imports in MetaMesh and Match; define separate artifact entry points without bypassing authorization.
- [x] Build a policy WASM artifact independent of Iroh/WebRTC transport dependencies and a separately loaded transport artifact; preserve shared identity and authority contracts.
- [x] Wire Match startup to the policy artifact and network operations to the transport artifact; keep required policy initialization before hydration.
- [x] Verify policy-load failure remains explicit and does not enable unauthorized reads or writes.
- [x] Run policy/transport contract checks, production build and size checks, and happy plus failure/pending browser scenarios; inspect production requests to confirm startup does not fetch transport assets.
- [x] Record measured artifact sizes, verification results, and remaining limitations in architecture and audit documentation.

## Verification

- Match quality checks pass; 849 unit tests pass, one existing skip. MetaMesh
  type checks and 284 tests pass on its pinned dependencies.
- Production-route packaging BDD: 3 scenarios pass, covering local saves across
  reload with no transport WASM requests, transport failure/retry, and policy
  failure blocking access.
- Real browser pairing and durable document delivery pass; repeated invitation-tab
  reload preserves editor access and resumes two-way sync without approval. Closing
  and reopening a peer tab delivers queued changes; all three histories pass.
- Artifact dependency check finds no Iroh/WebRTC in policy; both generated artifacts
  initialize and policy pairing frames round-trip.
- Policy WASM: 1,098,334 bytes Brotli against a new 1.2 MB budget. Transport WASM:
  2,190,888 bytes Brotli against the unchanged 2.3 MB budget. Initial JavaScript:
  227.01 kB against the unchanged 235 kB budget.
- Production packaging BDD runs in its own CI job and through `npm run test:e2e:policy`.
