## 1. Outer BDD first
- [x] 1.1 Add failing real-route Given/When/Then browser scenarios for whole-item and selected-text Discuss, explicit mention, global log, and source highlighting.
- [x] 1.2 Add reply-to-reply and two-anchor scenarios proving one durable message across views.
- [x] 1.3 Add desktop/tablet/keyboard window scenarios plus resize, viewport shrink, close/reopen, and pending/failure checks.
- [x] 1.4 Add copied-link scenarios for known workspace, target beyond initial rendered history, rekey, unknown scope, missing message, loading, and clipboard denial.

## 2. Message contract and projections
- [x] 2.1 Define bounded anchors, mentions, reply/root metadata, canonical text selection mapping, and versioned signed payload compatibility.
- [x] 2.2 Validate and persist signed metadata atomically; include it in retention accounting and duplicate/conflict checks.
- [x] 2.3 Integrate sync capability boundary, legacy plain-message reads, out-of-order replies, and deduplicated notifications.
- [x] 2.4 Implement item/selection/root conversation projections and safe unique-match anchor resolution.

## 3. Contextual interaction
- [x] 3.1 Build one Discuss action, attached-anchor composer, participant mention selection, and accessible desktop/touch/keyboard entry points.
- [x] 3.2 Render reference chips, root groups, immediate reply quotes, and unavailable/changed-source states.
- [x] 3.3 Preserve draft/context on failure, show pending sends, and enforce visitor/read-only permissions.

## 4. Shared windows
- [x] 4.1 Implement local window descriptors, geometry persistence, deduplicated open/focus, and shared focus/z-order ring.
- [x] 4.2 Integrate item details, workspace chat, and anchor/root conversations; retain true modal dialogs above nonmodal windows.
- [x] 4.3 Implement pointer/keyboard move and resize, viewport clamping, workspace layout isolation, responsive view navigation, and focus restoration.

## 5. Message links
- [x] 5.1 Implement versioned scope/message link codec preserving deployment base path and existing routes; validate external input.
- [x] 5.2 Add Copy message link for committed messages with local-availability help and selectable fallback on clipboard failure.
- [x] 5.3 Resolve authorized known workspaces, load retained target, and focus/highlight its conversation/message.
- [x] 5.4 Show unknown-workspace, missing-message, blocked-access, and loading states; retain unresolved target for explicit retry after join/import.

## 6. Verification
- [x] 6.1 Pass outer browser happy/failure/pending flows on desktop, tablet, narrow portrait, and keyboard, using isolated browsers.
- [x] 6.2 Pass focused protocol/storage/query tests: tampering, bounds, duplicate conflicts, pruning, out-of-order replies, legacy reads, and rekey resolution.
- [x] 6.3 Verify independent-peer convergence and mention notification deduplication with contextual messages.
- [x] 6.4 Run relevant type/lint/build checks and validate final OpenSpec; document remaining compatibility/discovery limits.
