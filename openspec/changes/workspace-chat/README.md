# Workspace chat and durable workspace mesh

## Delivered behavior

- Chat per workspace, separate IndexedDB journal (`match-chat-v1`), not a growing Automerge document.
- Per-workspace display names, random defaults, deterministic suffixes on collisions. Identity IDs remain authoritative.
- Settings show known signed participant profiles and the workspace owner; presence is not inferred from this list.
- Messages signed by certified device keys. Admission validates the author's identity/certificate chain and an owner-issued workspace grant for non-owners.
- Message records include a stable chat scope (owner identity plus original board ID), so unrelated legacy workspaces both named `default` cannot mix chat histories. Local workspace rekeying preserves the chat scope.
- Storage atomically enforces 2,000 messages and 4 MiB per workspace, whichever is reached first. A monotonic pruning cutoff prevents importing discarded history again. At most 512 profiles and 32 KiB per signed record; text up to 8,000 codepoints.
- Immutable message IDs, idempotent imports, deterministic profile revisions. Read cursors are local and monotonic.
- Initial workspace invitation/acknowledgement includes retained history. Live connections send unseen signed records; each live session owns its send cache. Old clients can ignore the optional chat envelope.
- Post-commit events drive rendering and sync. BroadcastChannel updates sibling tabs. Visible, focused tabs claim toast notifications under a browser lock. Initial/reconnect history and duplicate records do not produce toasts.
- Composer keeps drafts on write failure; no success or send event before the IndexedDB transaction completes.
- A stable Iroh node key, per-workspace mesh credential, signed peer advertisements, grants, and signed owner revocations persist in a separate peer catalog.
- One tab becomes network leader. Trusted peers reconnect after all tabs close and reopen. Peers introduced by the owner exchange the signed catalog and can sync directly without the owner online.
- Settings expose trusted devices, presence, role, and owner-only access removal. Owner decisions form the authority chain; revocation needs no vote or consensus.

## Explicit boundaries

Device enrollment's legacy single-document transport does not carry workspace chat. No permanent server replica exists. Existing peers paired by an older build need one new workspace invitation because they do not possess the workspace mesh credential.

No remote delivery receipts, attachments, message editing/deletion or system notifications yet. Retention is a local storage policy, not remote erasure. Offline writes remain local until peers connect. A restored/imported workspace without identity keys cannot impersonate the original owner; it needs a valid grant to send messages. Revocation is eventually consistent across partitions: an offline peer learns it after contacting an up-to-date member. The shared workspace transport secret is not rotated in this slice; signed membership checks and tombstones enforce admission among updated peers.

## Verification

`e2e/chat.spec.ts`: profile persistence, desktop/mobile send/reload, storage failure and retry, two independent peers, name conflicts and network reconnect.

`e2e/chat-storage.spec.ts`: real IndexedDB concurrency, duplicate/conflict handling, count/byte retention, prune cutoff, transaction atomicity, cursor monotonicity and reload.

`e2e/durable-mesh.spec.ts`: close/reopen reconnect, direct editor-to-editor sync after the owner leaves, and owner revocation.

`src/chat/records.test.ts`: real Ed25519 signatures, owner/editor admission, delegated certificates, tampering, impersonation, wrong workspace, invalid grants, bounds.
