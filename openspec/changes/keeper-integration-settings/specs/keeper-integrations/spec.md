## ADDED Requirements

### Requirement: Owner can inspect and update an existing integration
The application SHALL display the verified active board scopes, integration revision, and future-board policy for a saved Rusty integration. Owner settings SHALL target the saved integration ID and SHALL NOT remove and recreate or rebind that integration.

#### Scenario: Current settings load
- **WHEN** an owner opens an active Rusty integration
- **THEN** the application displays only service-verified active scopes and the verified future-board policy
- **AND** a status failure leaves cached settings visible with an explicit retry/error state

### Requirement: Expanding access requires both approvals
Adding a board or enabling future-board access SHALL require a comparison-code operation bound to the current integration ID, revision, exact additions, and policy baseline. The application SHALL preserve currently active scopes while approval is pending.

#### Scenario: Add a board after dual approval
- **GIVEN** an active integration and a newly selected owner board
- **WHEN** controller and operator approve the same comparison code and Rusty commits the owner-signed grant
- **THEN** Rusty adds only that board at a grant epoch greater than any tombstone
- **AND** prior active scopes remain active
- **AND** the application updates its local reference only after verifying the service-signed completion

#### Scenario: Approval remains pending
- **WHEN** either approval is absent or provisioning has not committed
- **THEN** no added board becomes active
- **AND** existing scopes remain usable and the pending operation can be reopened, retried, or cancelled safely

### Requirement: Reductions do not wait for operator approval
Removing an active board or disabling future-board access SHALL use an owner-signed request and SHALL NOT require operator approval. Requests SHALL carry the current integration revision and exact active grant epochs.

#### Scenario: Remove one board
- **WHEN** the owner removes one board from an integration with other active boards
- **THEN** Rusty records a tombstone for exactly the selected board generation and retries exact cleanup
- **AND** every other active board remains active
- **AND** the future-board policy remains unchanged
- **AND** the removed board is added to the future baseline if future access remains enabled

#### Scenario: Disable future boards
- **WHEN** the owner turns off future-board access
- **THEN** Rusty commits the owner-signed policy update at the expected revision
- **AND** existing active board scopes remain active
- **AND** later automatic offers prepared against an older revision are rejected

### Requirement: Future consent excludes existing unselected boards
When future-board access is enabled, the signed baseline SHALL include every board owned at approval time, whether currently selected for the integration or not. Only later-created boards are eligible for automatic offer.

#### Scenario: Existing unselected board
- **WHEN** future access is enabled while an owned board is not selected
- **THEN** the unselected board remains excluded from automatic offer
- **AND** the owner must add it through the dual-approval expansion flow

### Requirement: Update retries are fenced and durable
Rusty SHALL compare the expected integration revision before changing policy or scopes. Identical operation retries SHALL return the same durable result; operation-ID reuse with a different payload SHALL conflict. Cleanup and activation failures SHALL preserve retryable intent without falsely reporting completion.

#### Scenario: Stale update
- **WHEN** another integration update advances the revision first
- **THEN** the stale operation changes no scopes or policy
- **AND** the application keeps existing settings visible and offers refresh/retry
