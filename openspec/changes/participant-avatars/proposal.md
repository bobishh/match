## Why

Participants currently appear primarily as names. A stable visual identity makes authors easier to recognize across chat messages, participant lists, and future object discussions without requiring profile setup or image downloads.

## What Changes

- Generate a deterministic illustrated avatar from each participant's stable person ID using a shared versioned renderer.
- Show avatars beside author names in chat and existing workspace participant lists.
- Reuse the same component in mention completion and object conversations when those surfaces are delivered.
- Keep identity, authorization, and presence separate from avatar appearance.
- Preserve author clarity when grouping consecutive messages and when profiles are missing.
- Let each participant crop and share a small custom photo through a per-person Automerge profile record.

## Capabilities

### New Capabilities
- `participant-avatars`: Stable participant illustrations and accessible author presentation.

### Modified Capabilities
- None.

## Impact

Shared avatar component, chat author presentation, participant settings, an owned profile command, bounded crop encoding, and isolated browser tests. Custom photo bytes live inline in the workspace CRDT; no remote blob store is added. Card participant/assignee/presence indicators remain deferred until product semantics exist.
