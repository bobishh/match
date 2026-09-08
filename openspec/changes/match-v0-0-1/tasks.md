## 1. Product surface

- [x] 1.1 Create standalone Vue 3 + TypeScript + Vite app under `match/`.
- [x] 1.2 Render five Trello-equivalent columns: Lead, Applied, Interview, Rejected, Offer.
- [x] 1.3 Add flat lead creation form with duplicate detection.
- [x] 1.4 Add selected-card detail panel with status controls.
- [x] 1.5 Add document attachment flow and visible document badges.
- [x] 1.6 Add IndexedDB persistence and JSON fallback export.
- [x] 1.7 Store workspace as Automerge bytes and export `.match` bundle.

## 2. WebMCP

- [ ] 2.1 Register flat imperative tools after first browser preview.
- [ ] 2.2 Validate valid create/move/document tool calls against visible state.
- [ ] 2.3 Validate invalid field and nested-payload failures without state corruption.

## 3. Merge and sync boundary

- [x] 3.1 Persist Automerge workspace document rather than JSON snapshots.
- [x] 3.2 Keep separate card/document IDs and include change state in export.
- [x] 3.3 Keep transport outside the Automerge merge boundary.
- [x] 3.4 Add browser iroh WebRTC/WASM adapter spike behind explicit experimental capability.
- [x] 3.5 Add QR invite, manual scan/paste, and app-layer peer authorization.
- [x] 3.6 Split `SyncTransport`, session protocol, and Vue flow; QR starts acceptance and invite joins automatically.
- [x] 3.7 Retry transient browser bootstrap failures without a second user action.

## 4. Verification

- [ ] 4.1 Add Playwright happy-path board/card/document flow.
- [ ] 4.2 Add validation failure flow for missing company/role and duplicate URL.
- [ ] 4.3 Add reload persistence check.
- [ ] 4.4 Add responsive board/detail-panel check.
- [x] 4.5 Add protocol/session tests and isolated-profile QR pairing BDD coverage.
