# Match

Match is a local-first, peer-to-peer workspace board and task kernel with incremental sync, cryptographic proofs, and multi-device collaboration.

## Features

- **Generic Workspace Kernel**: Create independent workspaces (such as the default *Job search* pipeline or *Blank* boards) with custom columns, rational rank positioning, nested subtask hierarchies, and customizable fields (select, text, number, date).
- **Preset Adapters & Legacy Aliases**: The *Job search* preset maps generic tasks to lead properties (company, role, status, priority, fit score, notes, source snapshot), CV/cover-letter templates, and generated PDF artifacts while preserving full backward compatibility.
- **Trash & Needs Placement Recovery**: Soft-deleted columns and cards can be restored safely. Tasks with missing parents or cyclic references are deterministically surfaced under *Needs placement* for recovery without destructive repair writes.
- **Local Automerge Durability**: All mutations are recorded as signed Automerge changes persisted atomically with change hashes, receipts, and public proofs in IndexedDB. Focus changes and `BroadcastChannel` synchronize same-device tabs instantly without network pairing.
- **Two Scoped Connection Flows**:
  1. **Sync all (Add my device)**: Enrolls a secondary device into your personal identity root. Generates a fresh device key, derives a short mutual transcript authentication code for visual approval, signs a delegated device certificate, and syncs your live workspace catalog.
  2. **Sync workspaces**: Issues owner-signed *editor* grants scoped exclusively to a designated fixed set of workspaces (one or multiple). Guests never receive or learn about unselected workspaces, titles, future workspaces, or your private root.
- **Incremental Mesh Replication & Blob Transfer**:
  - Employs native Automerge per-peer per-document sync states. Live updates transmit only small change deltas (typically <1% of full document size).
  - Bounded framing limits physical frames to 1 MiB with reassembly up to 32 MiB.
  - Content-addressed blob storage with SHA-256 validation and resumable 256 KiB chunks.
  - Granular progress reporting separating document sync frontiers from pending file transfers.
- **Export Guarantees**: Exported `.match` bundles contain workspace metadata, task documents, Automerge CRDT history bytes, and public cryptographic proofs (`proofs.json`). Private signing keys, personal root documents, and pairing secrets are strictly excluded.
- **Browser Lifetime & Persistence**: Peer-to-peer sync operates while browser tabs/workers remain open. Known peer trust and enrolled device certificates persist in IndexedDB across reloads without requiring another QR code scan.
- **Explicit Limitations**: No central servers, accounts, or corporate organizations. Remote key revocation across offline peers and server-side secret recovery are explicitly unsupported.

## WebMCP Tools

When opened in an environment exposing WebMCP (`document.modelContext` or `navigator.modelContext`), Match registers generic task commands alongside legacy lead aliases:

### Generic Commands
- `list_workspaces` — list available workspaces.
- `create_workspace` — create a new workspace (Blank or Job search preset).
- `list_tasks` — list tasks within the active workspace with optional column/search filters.
- `create_task` — create a task with customizable fields and rank.
- `move_task` — move a task to another column or under a parent task.
- `export_workspace` — download the workspace as a `.match` bundle.

### Legacy Aliases (Job Search)
- `list_leads` — list leads with status and search filtering.
- `create_lead` — create a lead card with company, role, and status.
- `move_lead` — move a lead card by ID and status.
- `list_templates` — read Markdown CV and cover-letter templates.
- `get_generation_context` — retrieve card and template context for artifact generation.
- `record_pdf_artifact` — attach a generated PDF artifact to a lead.
- `add_document` — attach a note or file reference to a lead.

## Development & Verification

### Local Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the browser Iroh/WASM transport adapter:
   ```bash
   npm run build:iroh
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   ```

### Test Suites
- **Unit and Integration Tests**:
  ```bash
  npm test
  ```
- **Playwright End-to-End Tests**:
  ```bash
  npx playwright test
  ```
  Runs real-route BDD scenarios covering generic workspaces, column renames, subtask movements, Trash recovery, save failures, isolated-profile device enrollment (`Sync all`), scoped guest collaboration (`Sync workspace`), expired invitation rejection, and post-reload durable trust.
