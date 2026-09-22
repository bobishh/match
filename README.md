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
```

See [playwright.config.ts](playwright.config.ts) for all projects. CI runs the static
checks, unit tests, bundle budgets, dependency audit, and browser suites. Historical
measurements in [CODE_QUALITY_AUDIT.md](CODE_QUALITY_AUDIT.md) are dated snapshots,
not a substitute for the current CI result.

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
