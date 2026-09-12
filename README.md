# Match

Match is a local-first, peer-to-peer workspace board and task kernel with incremental sync, cryptographic proofs, and multi-device collaboration.

## Features

- **Generic Workspace Kernel**: Create independent workspaces (such as the default *Job search* pipeline or *Blank* boards) with custom columns, rational rank positioning, nested task hierarchies, workspace document templates, and typed fields (text, number, boolean, select, URL, date, datetime).
- **Preset Adapters & Legacy Aliases**: The *Job search* preset maps generic tasks to lead properties, document templates, and generated PDF artifacts while preserving its older lead-oriented tools.
- **Trash & Needs Placement Recovery**: Soft-deleted columns and cards can be restored safely. Tasks with missing parents or cyclic references are deterministically surfaced under *Needs placement* for recovery without destructive repair writes.
- **Local Automerge Durability & Restore**: All mutations are recorded as signed Automerge changes persisted atomically with change hashes, receipts, and public proofs in IndexedDB. Task history can restore any recorded version through a new compensating change; original evidence remains immutable. Focus changes and `BroadcastChannel` synchronize same-device tabs instantly without network pairing.
- **Two Scoped Connection Flows**:
  1. **Add my device**: Enrolls your own secondary device into your identity using its device key and a verified certificate chain. Both devices compare a code bound to the request; approval sends the current owned workspaces and durable mesh credentials. Success appears only after the recipient saves the data and acknowledges receipt. Root private keys stay on their original device. This is not a participant invitation and has no role selector. Existing independent workspace data requires a workspace invitation or a fresh browser profile; identity merging is not supported. Future workspaces and workspaces owned by someone else are not automatically added by this enrollment flow.
  2. **Sync workspaces**: Requests explicit owner approval and issues owner-signed *visitor* (default) or *editor* grants scoped exclusively to a designated fixed set of workspaces (one or multiple). Guests never receive or learn about unselected workspaces, titles, future workspaces, or your private root.
- **Incremental Mesh Replication & Blob Transfer**:
  - Employs native Automerge per-peer per-document sync states. Live updates transmit only small change deltas (typically <1% of full document size).
  - Bounded framing limits physical frames to 1 MiB with reassembly up to 32 MiB.
  - Content-addressed blob storage with SHA-256 validation and resumable 256 KiB chunks.
  - Granular progress reporting separating document sync frontiers from pending file transfers.
- **Workspace Chat & Presence**: Each workspace has signed local-first chat, workspace-specific display names, ephemeral signed typing indicators, and live editor/device counts. Typing state expires and never enters durable chat history. Chat retains the newest 2,000 messages within a 4 MiB cap in a separate IndexedDB journal.
- **Export Guarantees**: Exported `.match` bundles contain workspace metadata, task documents, Automerge CRDT history bytes, and public cryptographic proofs (`proofs.json`). Private signing keys, personal root documents, and pairing secrets are strictly excluded.
- **Browser Lifetime & Persistence**: A stable local node identity, workspace mesh credentials, signed peer advertisements, grants, and revocation records persist in IndexedDB. One elected tab owns the network node. Trusted peers reconnect after every tab closes and reopens; peers introduced by a common owner can later sync directly without that owner online.
- **Workspace Roles**: Owner can edit everything, invite, and revoke. Editor can edit items and their attachments, but cannot change board structure, fields, templates, or workspace settings. Visitor can view the workspace and chat; writes and dragging are disabled. Owners see each join request with the participant name and approve a role (visitor by default).
- **Write Authorization**: Shared document changes carry device signatures and owner-issued grants. The same domain transition policy checks local commands and signed incoming changes. Forwarded changes retain their original authorization. A separate IndexedDB journal stores public write authorizations; old history is checkpointed by the owner. All peers must reload this version before sharing new writes.
- **Schema Architecture**: Entity schemas in `src/domain/entitySchemas.ts` define both runtime validation and inferred TypeScript types. `validation.ts` adapts schema errors and parent rules; `permissions.ts` owns role policy. Protocol types remain in `model.ts`.
- **Owner-Controlled Access**: Workspace settings list trusted devices and presence. Only the workspace owner can invite or revoke. Signed revocations gossip through the mesh without consensus.
- **Trusted-Group Ownership Recovery**: Owner may name one editor successor or enable strict-majority editor recovery. One signed vote per editor and epoch-bound claims prevent ordinary double election. Conflicting valid claims pause writes instead of silently selecting divergent owners; Match does not claim Byzantine consensus.
- **Upgrade Behavior**: Existing task databases need no schema rewrite. Chat and peer state use new databases created lazily. Devices paired before durable mesh support need one new workspace invitation to receive the shared mesh credential and signed catalog.
- **Explicit Limitations**: No central servers, accounts, corporate organizations, permanent replica, or server-side secret recovery. Revocation is eventually consistent while peers are offline: a partitioned peer rejects revoked access only after receiving the owner's signed tombstone from an up-to-date peer.

## WebMCP Tools

When opened in an environment exposing WebMCP (`document.modelContext` or `navigator.modelContext`), Match registers generic workspace commands alongside job-search compatibility aliases. Commands target the workspace currently open in Match.

### Generic Commands
- `list_workspaces` — list available workspaces.
- `create_workspace` — create and open a Blank or Job search workspace.
- `rename_workspace` — rename the current workspace.
- `get_workspace` — read the current workspace and active board summary.
- `get_workspace_settings` — read the complete editable configuration and CRDT heads.
- `apply_workspace_settings` — validate and atomically apply workspace title, board, columns, fields, and document templates.
- `list_tasks` — list visible tasks with optional parent and search filters.
- `get_entity` — read one typed entity by stable UUID.
- `create_task` — create a task under a column or another task.
- `patch_task` — update task title, body, or typed field values.
- `move_entity` — move or reorder an entity under a column or task.
- `rename_entity` — rename an entity without changing placement.
- `set_entity_deleted` — soft-delete or restore an entity.
- `restore_and_move` — restore an entity under a valid parent in one transaction.
- `list_trash` — list explicitly soft-deleted entities.
- `list_placement_issues` — inspect missing-parent and cyclic ancestry problems.
- `create_column` — create a column under a board.

Complete settings writes should preserve returned entity IDs and pass returned heads as `expectedHeads`. Omitted columns, fields, and document templates are soft-deleted while their descendants and stored values remain intact. Unknown fields, stale heads, and field type changes are rejected without partial mutation.

### Job Search Compatibility Aliases
- `list_leads` — list leads with status and search filtering.
- `create_lead` — create a lead card with company, role, and status.
- `move_lead` — move a lead card by ID and status.
- `list_templates` — read workspace document templates through the legacy shape.
- `get_generation_context` — retrieve card and template context for artifact generation.
- `record_pdf_artifact` — attach a generated PDF artifact to a lead.
- `add_document` — attach a note or file reference to a lead.
- `export_workspace` — export through the compatibility workspace shape.

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
  Runs real-route BDD scenarios covering generic workspaces, column renames, subtask movements, Trash recovery, save failures, isolated-profile device enrollment (`Add my device`), scoped guest collaboration (`Sync workspace`), expired invitation rejection, and post-reload durable trust.
