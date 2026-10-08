## Protocol

Treat settings as operations on one stable integration ID. Every request carries a unique operation ID, exact integration revision, and exact scope delta. The controller identity and service identity bind the signed request. Rusty validates owner scope authority, grant epochs, and current revision before recording an intent.

An expansion is an existing pairing operation with an integration-update payload. The comparison code binds integration ID, expected revision, added workspace IDs, and requested future policy. Existing active scopes stay usable while operator and owner approvals are pending. Only after both approvals does the owner send the exact new workspace invitation. Rusty admits the owner-signed grants and commits the delta; it does not replace or rebind the integration.

A reduction or future-policy disable is owner-signed and can proceed without operator availability. A board removal carries its active grant epoch and creates a tombstone for exactly that scope. It retains unrelated active scopes and the existing future policy. If future access stays enabled, removed board IDs join the baseline so the future-offer path cannot immediately re-add them. Disabling future access retains all active scopes and blocks later automatic offers.

Enabling future access is an expansion and requires both approvals. Its baseline contains every currently owned board, including boards not selected for this integration. Automatic admission therefore applies only to boards created after approval. The update and automatic-offer paths share revision CAS; an offer prepared against an older revision cannot reactivate follow-owner after an owner disables it.

Rusty records operation hash, expected revision, exact added/removed IDs, requested policy, approval state, and completion receipt durably. Same operation ID and same payload returns the same result; reused IDs with another payload conflict. Stale revision conflicts without changing active scopes or policy. Cleanup failures remain pending and retryable. Status and completion receipts are service-signed; the client updates local settings only after verifying them.

## Safety

- No board outside the controller's owner-signed exact addition set is admitted.
- Active scopes remain unchanged until an expansion commits.
- A completed removal tombstone covers the removed grant epoch; later re-addition needs a strictly newer owner-signed grant.
- A removed board cannot be automatically re-added by an existing future policy.
- Turning future access off cannot be undone by a stale future-board offer.
- A revision conflict, invalid receipt, or unavailable service leaves local active scopes and policy unchanged and exposes retry/status.
- Owner boundary records and device identity remain unchanged by integration settings.
