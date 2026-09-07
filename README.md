# Match

Match is a local-first Trello-like board for job leads and vacancy documents.

v0.0.1 surface:

- five pipeline columns: Lead, Applied, Interview, Rejected, Offer;
- flat lead cards with company, role, source URL, fit, priority, notes, and source snapshot;
- documents attached directly to cards;
- IndexedDB persistence with Automerge document storage;
- `.match` portable bundle export with manifest, card/document JSON, and Automerge bytes;
- experimental browser iroh/WASM node under `iroh-wasm/`;
- QR invite with app-layer bearer-secret authorization before device merge;
- Vue 3 + TypeScript + Vite frontend;
- no backend, account, or organization setup flow.

Automerge is the merge layer. iroh is the experimental device transport; it is not silently reported as connected. QR pairing carries the iroh endpoint plus a random bearer secret. The receiver rejects stream data with a missing or mismatched secret. The visible app does not expose CRDT payload shape to WebMCP callers.

Build the browser transport with `npm run build:iroh`; it needs Rust wasm target plus LLVM/LLD. The browser crate is `iroh-webrtc-transport` `0.1.0-alpha.2`, so pairing stays explicitly experimental.
