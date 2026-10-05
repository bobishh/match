## 1. Outer BDD first
- [x] 1.1 Add failing real-route browser scenarios for avatars in chat and participant settings on desktop and narrow portrait.
- [x] 1.2 Cover stable appearance across reload/name changes/devices, same-name participants, and missing-profile offline fallback.
- [x] 1.3 Cover pending/failed send author attribution and unchanged status/draft recovery.

## 2. Default avatars
- [x] 2.1 Define fixed versioned identity hash, bounded feature palette, and illustrated renderer with neutral invalid-ID fallback.
- [x] 2.2 Build accessible shared avatar component using trusted vector primitives and no external requests.
- [x] 2.3 Integrate chat author headers and existing participant lists while preserving names, disambiguation, actions, and presence semantics.
- [x] 2.4 Preserve per-message attribution/status if grouping adjacent messages; expose component for future mention/discussion surfaces without implementing those flows.

## 3. Verification
- [x] 3.1 Pass happy-path and pending/failure browser scenarios with isolated browsers.
- [x] 3.2 Verify deterministic fixtures, invalid-ID fallback, accessible labels, and unchanged existing chat behavior.
- [x] 3.3 Run relevant type/lint/build checks and strict OpenSpec validation.
