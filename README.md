# Match

A board for keeping track of work, with cards, documents, and chat. Your data lives
in your browser. You can share a board with someone else or connect your own
second device and keep working across both.

[Try Match](https://match.meta-uber-engineer.dev/) · [Five-minute demo](docs/demo.md) · [Architecture](docs/architecture.md)

## What you can do

- Create a blank board or a job-search pipeline; edit cards, columns, and fields.
- Attach documents, preview supported files, and download attachments.
- Work locally, then synchronize with another online device.
- Share selected boards with an editor or a read-only visitor.
- Inspect item history and restore an earlier version without erasing history.
- Export a `.match` workspace bundle. Identity secrets are not included.

Match is an experimental application. Keep an independent backup of important
work. Browser storage is a local copy, not a hosted backup service.

## Card aging

Inactive cards gradually turn olive and then brown after 7, 14, and 30 days.
Owners can change these thresholds under **Edit board → Edit item/lead**.
Editing a card, adding a note, moving it to another column, or choosing
**Reviewed** restarts its activity clock. Reordering within a column does not.
Archived cards and columns named Done, Complete, or Completed are excluded.
The display calculates age locally; the passage of time does not write to the
shared document.

## Try sharing a board

1. Open Match in two browsers or browser profiles. Give each profile a different
   display name so it is easy to tell them apart.
2. In the first browser, create a board and a card.
3. Open **Sync → Add someone**, choose the board and role, and generate a link.
4. Open that link in the second browser, request access, and approve it in the first.
5. Edit a card as an editor and watch the other browser update. Reload the second
   browser to check that its access and data persist.

**Add my device** is a separate flow: it enrolls another device as the same user.
Compare the authentication codes and approve on the existing device. Use a fresh
profile for a demo so you do not enroll someone else's browser into your identity.

The [demo guide](docs/demo.md) covers offline edits, attachments, and what to explain
when showing the project.

## Identity and access

- Enrolling into another identity requires explicit confirmation. The previous
  identity is backed up locally; enrollment does not merge people or their rights.
- Conflicting workspace IDs or owners stop the import without replacing the local
  board. A newer grant cannot be overwritten by an older network announcement.
- In **Sync**, an owner can select a visitor and choose **Make editor**.
- **Remove device** asks whether to apply to this board or all eligible boards,
  listing the affected boards. Editors can remove their own other devices; owners
  can remove other participants' devices only from boards they own. Removal is
  signed and survives reconnects. Reusing a removed device requires a new device
  identity; old local copies cannot be remotely erased.
- **Leave mesh** leaves the participant's membership on all their devices for that
  board, while preserving the identity and other boards. Owners must transfer
  ownership first. A peer must be connected to deliver the departure; the local
  copy remains read-only, and returning requires a new invitation.

Reload Match on both sides after this protocol update. Older clients cannot join
sessions until they support device removals and membership departures.

## Run locally

Requirements: Git and Node.js 22 or newer. Rust is **not** needed to run Match:
the pinned MetaMesh dependency contains its prebuilt browser JavaScript and WASM.
Automerge also ships its compiled WASM in its npm package.

```sh
git clone --recurse-submodules https://github.com/bobishh/match.git
cd match
npm ci
npm run dev
```

For an existing checkout:

```sh
git submodule sync --recursive
git submodule update --init --recursive
npm ci
```

Open the local URL printed by Vite. A phone accessing a development server needs
a secure browser context for the cryptographic/browser APIs; use the HTTPS demo
for a two-device trial unless you have configured local HTTPS.

```sh
npm run build            # type-check and create dist/
npm run preview          # serve the production build locally
```

[MetaMesh](https://github.com/bobishh/meta-mesh) is a public repository pinned as a
Git submodule. No GitHub credentials or deploy key are required to fetch it. Its
packages are consumed from source; they are not currently published to npm.
Only contributors changing the Rust runtime need its [WASM build instructions](vendor/meta-mesh/scripts/build-wasm.sh).

## Verify changes

```sh
npm run verify:meta-mesh
npm run quality
npm test
npx playwright install chromium
npx playwright test --project=core
```

The core browser suite exercises local UI and persistence. Network suites use real
Iroh connectivity and are separate so connectivity failures are visible:

```sh
npx playwright test --project=scoped-enrollment
npx playwright test --project=workspace-roles
npx playwright test --project=workspace-sync-data
npx playwright test --project=durable-mesh
```

See [playwright.config.ts](playwright.config.ts) for all projects. CI runs the static
checks, unit tests, bundle budgets, dependency audit, and browser suites. Historical
measurements in [CODE_QUALITY_AUDIT.md](CODE_QUALITY_AUDIT.md) are dated snapshots,
not a substitute for the current CI result.

## Recovery and verification

The [durable mesh browser suite](e2e/durable-mesh.spec.ts) exercises real Iroh
connections and browser storage, including:

- Unexpected transport-node closure: create a replacement node, reconnect, and
  synchronize edits in both directions without reloading or pairing again.
- Failed receive persistence: leave the saved document and journal unchanged,
  send no saved-state acknowledgement, then replay and acknowledge after storage
  recovers and the connection is re-established.
- Repeated disconnections with two tabs of one device: converge on edits, retain
  roles, and check that nodes, sessions, and timers do not accumulate. Each tab
  has an independent channel; opening a tab does not create another device.

An ownership handoff keeps its pending proposal separate from accepted authority.
While confirmation is pending, local document writes are blocked. Retrying uses
that same proposal; accepting the handoff stores the resulting ownership and
scope authority together.

MetaMesh also checks ownership/revocation, session generations, and batch delivery
with [executable protocol models](vendor/meta-mesh/formal/README.md). The runner
compares transitions against production Rust, explores bounded concrete states,
and requires deliberately broken implementations to fail. This is bounded
conformance testing, not a proof for every possible execution. Browser transport,
storage failures, and adapter wiring are tested separately by the scenarios above.
Recovery requires the peer, network, and storage to become available again.

## What to expect

- **Availability:** another device must be reachable to receive new data or fetch
  an attachment that is not stored locally. There is no permanent hosted replica.
- **Connectivity:** peers use Iroh discovery and relay infrastructure when needed;
  P2P does not mean infrastructure-free or guaranteed connectivity on every network.
- **Local startup:** Rust/WASM policy code loads before stored documents are opened.
  No network connection to another peer is needed, but local-first does not yet
  include a service worker guaranteeing a cold offline launch.
- **Permissions:** owner/editor/visitor checks run at command and replication
  boundaries as well as in the UI. Revocation reaches offline peers when they
  reconnect; it cannot erase copies they already hold.
- **Recovery:** ownership succession is a trusted-group feature, not Byzantine
  consensus. Match has no complete account recovery or stolen-device recovery UI.
  MetaMesh's recovery primitives alone do not supply that product flow.
- **Protocol updates:** refresh both peers when testing a new deployment.
- **Security:** signed changes and device certificates are implemented; the system
  has not received an independent security audit or Signal-equivalent guarantees.

## How it is built

Vue presents the board. Application modules coordinate commands, storage, and
collaboration. Automerge represents workspace history; IndexedDB stores local
snapshots and authorization records. MetaMesh supplies shared identity, protocol,
transport, and runtime primitives used by Match and Twang.

The [architecture notes](docs/architecture.md) explain these boundaries and the
remaining compromises. The [protocol and WebMCP reference](docs/protocol-and-tools.md)
contains the detailed feature and tool catalog.
