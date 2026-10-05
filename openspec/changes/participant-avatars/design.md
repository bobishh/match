## Context

Chat already attributes signed messages to stable person IDs and resolves workspace display names, including name collisions. Device IDs identify signing devices; they must not determine a person's avatar. Object discussions and mention completion are planned in `object-anchored-conversations`, not delivered prerequisites for this change.

## Decisions

1. Derive a compact illustrated face/creature from the full stable person ID using a fixed hash algorithm, feature palette, and renderer version. Do not use random session state, display names, device IDs, locale, or workspace IDs. The same identity has the same default across devices and workspaces.
2. Render with trusted application-owned vector primitives and bounded parameters, matching the existing drawn interface. Do not inject user-supplied SVG/HTML, load remote avatar services, or generate bitmap assets per participant.
3. Use several visual features as well as color. Avatars are recognition aids, not unique identity proofs: finite visual combinations may collide. Preserve resolved names and existing identity disambiguation; authorization continues to use verified person IDs.
4. Place an avatar beside each visible author-group header in chat and beside names in existing participant lists. Consecutive messages may share a header only when adjacent messages have the same person ID and no intervening date/context boundary. Grouping must remain derived presentation, never alter message records or hide per-message status/actions.
5. Keep adjacent author names visible. Treat the avatar as decorative when the name already labels its row; any future avatar-only interactive control needs an accessible person label. Avatars introduce no new tab stops unless they perform a defined action.
6. Resolve the avatar from message person ID even when the display profile is absent. Keep the current fallback author label. Empty/invalid IDs get a neutral placeholder, never a random or another participant's avatar.
7. Do not imply presence through avatar visibility, opacity, or an unexplained dot. Retain existing explicit presence semantics independently.
8. Provide a reusable renderer/component API for future mention completion and object discussions. Do not implement those unrelated flows in this change.

## Deferred

Custom pictures need their own bounded image ingestion, metadata/profile signing, blob replication, offline fallback, and replacement/removal contract. Card avatar strips need a defined relationship such as assignee or discussion participant; displaying arbitrary known participants would mislead. Neither is part of this slice.

## Validation

Outer BDD first: isolated Playwright on real application routes covering chat authors and participant settings, desktop and narrow portrait, same-person reload/device consistency, same-name participants, and missing-profile fallback. Check a pending or failed send retains correct author attribution and visible status. Validate deterministic rendering with fixed identity fixtures, safe placeholder behavior, type/lint/build checks, and existing chat behavior. Use an alternate port when the user server owns the default; do not inspect existing user browser tabs.
