## Why

Match users currently provision Lighthouse through a command-line invitation to one board. They need to connect a self-hosted keeper by hostname, choose their boards, and see whether data has actually been persisted while their other devices are offline.

## What Changes

- Add Sync → Add keeper with HTTPS discovery, owned-board selection and mutual approval.
- Model a keeper connection as an integration, separate from personal-device enrollment and board ownership.
- Default to read-only replication; require explicit editor permission for automation.
- Support existing and future owned boards through an explicit opt-in policy.
- Show authenticated persistence evidence per board, chat and attachments separately from connection presence.
- Support adding/removing scopes, revocation, service identity changes and recovery without replacing the user's identity.

## Capabilities

### New Capabilities
- `keeper-integrations`: Discovery, pairing, management, scoped authorization and replica status for a multi-integration Lighthouse service.

### Modified Capabilities
None. Existing workspace access checks remain authoritative; new integration management composes them.

## Impact

Match Sync UI, identity-scoped preferences, workspace invitations, signed authority, document/chat/blob persistence evidence, and browser integration tests. Shared cryptographic transitions belong to MetaMesh Rust and its bindings. The companion service change is [multi-integration-service](../../../../mesh-lighthouse/openspec/changes/multi-integration-service/proposal.md). This proposal does not claim the feature is implemented.
