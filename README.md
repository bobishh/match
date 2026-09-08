# Match

Match is a local-first Trello-like board for job leads and vacancy documents.

v0.0.1 surface:

- five pipeline columns: Lead, Applied, Interview, Rejected, Offer;
- flat lead cards with company, role, source URL, fit, priority, notes, and source snapshot;
- documents attached directly to cards;
- IndexedDB persistence with Automerge document storage;
- `.match` portable bundle export with manifest, card/document JSON, and Automerge bytes;
- `.match` bundle import and merge;
- experimental browser iroh/WASM node under `iroh-wasm/`;
- one-action QR pairing with app-layer bearer-secret authorization before device merge;
- Vue 3 + TypeScript + Vite frontend;
- no backend, account, or organization setup flow.

Automerge is the merge layer. iroh is one experimental `SyncTransport` adapter. A Sync modal starts an acceptor and renders a QR automatically. Opening or pasting its link prepares the scanning browser; Connect to mesh starts joining when the user chooses it. Temporary Iroh bootstrap failures retry while both tabs stay open. After authenticated request, response, and acknowledgement frames merge both workspaces, the same peer connection stays open and local edits replicate in both directions. Same-browser tabs reconcile persisted Automerge state through IndexedDB notifications and when returning to focus. Live sync ends when either tab stops it or closes; pairing again is required after a reload. The visible app does not expose CRDT payload shape to WebMCP callers.

Verification:

- `npm test` — pairing protocol and session/retry unit tests.
- `npm run test:e2e` — Sync opens without setup controls, invalid invite fails, and two isolated browser profiles merge plus replicate a later edit through one QR link.

Build the browser transport with `npm run build:iroh`; it needs Rust wasm target plus LLVM/LLD. The browser crate is `iroh-webrtc-transport` `0.1.0-alpha.2`, so pairing stays explicitly experimental.
