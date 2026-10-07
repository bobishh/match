## 1. Shared contracts and prerequisites

- [ ] 1.1 Add required standalone Rusty/browser scenarios for exact board scopes and independent controllers; fail when the pinned Rusty binary or fixture is missing.
- [ ] 1.2 Add shared Rust/WASM fixtures for the service protocol, transcript code, revision conflicts, expiration and idempotency.
- [ ] 1.3 Verify visitor store-and-forward with original writer proofs; fix shared admission if needed and prove visitor-authored edits remain rejected.
- [ ] 1.4 Integrate shared authority/revocation propagation and exact durable coverage APIs; pin tested MetaMesh and Lighthouse revisions.

## 2. Hostname and mutual approval UI

- [ ] 2.1 Add identity-scoped integration persistence with service pinning, device sync and conflict behavior.
- [ ] 2.2 Add hostname discovery, capability/version errors and owned-board/mode selection to Sync.
- [ ] 2.3 Add pending pairing with transcript code, fingerprints, operator-page link, cancellation/expiry and both approval states.
- [ ] 2.4 Bind the dedicated keeper Editor grant and existing invitation proof to the exact authenticated service identity and approved scopes; resume interrupted provisioning safely.
- [ ] 2.5 Cover success plus denied, unreachable, expired, changed-identity and partial-provisioning UI states.

## 3. Management and persistence visibility

- [ ] 3.1 Add scope additions/removals, per-scope automation permission and explicit disconnect affected-scope confirmation.
- [ ] 3.2 Add disabled-by-default future-owned-board policy with a signed eligible-scope baseline, authority recheck, revision conflicts and concurrent-tab deduplication.
- [ ] 3.3 Show document/chat/blob durable coverage independently of transport presence, including pending attachments and last-confirmed time.
- [ ] 3.4 Support verified keeper device replacement; reject revoked-device receipts and preserve user identity/local documents.
- [ ] 3.5 Persist local revocation and exact per-scope removal as visible pending state until Rusty's signed cleanup receipt; reject stale-generation replay and require fresh approval for re-add.

## 4. End-to-end acceptance and delivery

- [ ] 4.1 Prove two controllers with at least two boards each are isolated in the actual standalone service.
- [ ] 4.2 Prove owner-offline read-only relay, storage failure → retry → complete ACK, missing blob catch-up and restart convergence.
- [ ] 4.3 Prove scope removal/re-add with stale grants, pending cleanup across reload/restart, disconnect of one scope while another stays live, and existing intake routing.
- [ ] 4.4 Run affected browser/unit/type checks and shared contract validation once on the final changes.
- [ ] 4.5 Update user documentation; deploy compatible service first, then tincanban; verify a disposable production integration and report exact versions.
