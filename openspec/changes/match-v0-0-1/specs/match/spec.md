## ADDED Requirements

### Requirement: Trello-equivalent lead board

The system SHALL render one flat card pipeline with exactly five statuses: Lead, Applied, Interview, Rejected, and Offer.

#### Scenario: Board shows pipeline columns

- **WHEN** the app loads
- **THEN** it shows five status columns in this order: Lead, Applied, Interview, Rejected, Offer
- **AND** each column shows card count
- **AND** a lead belongs to one column based on its `status` value.

#### Scenario: User moves a card

- **WHEN** the user changes a selected card status
- **THEN** the card moves to the matching column
- **AND** the change persists after reload.

### Requirement: Flat lead cards

The system SHALL store company and role directly on a lead card. It SHALL NOT require organization creation or a separate vacancy record.

#### Scenario: Agent creates a lead

- **WHEN** a valid `create_lead` command supplies company, role, and status
- **THEN** the app creates one visible card
- **AND** the card appears in the requested status column
- **AND** no organization or application setup is requested.

#### Scenario: Invalid lead is rejected

- **WHEN** `create_lead` omits company, role, or uses an unsupported status
- **THEN** the command fails with field-level validation
- **AND** no partial card is persisted.

### Requirement: Attached documents

The system SHALL let each lead show and manage attached CVs, cover letters, notes, and file references.

#### Scenario: Card shows documents

- **WHEN** a lead has attached documents
- **THEN** its card shows compact document badges
- **AND** its detail panel lists document title, kind, and format.

#### Scenario: Agent attaches a document

- **WHEN** a valid `add_document` command supplies `leadId`, kind, title, and format
- **THEN** the document is attached to that lead
- **AND** the detail panel shows it without changing lead status.

### Requirement: Local workspace persistence

The system SHALL persist leads and documents on the current device without a backend.

#### Scenario: Reload preserves workspace

- **WHEN** the user creates a card or document and reloads the app
- **THEN** the same records remain available.

#### Scenario: User exports workspace

- **WHEN** the user invokes `export_workspace`
- **THEN** the app downloads a `.match` bundle containing a manifest, readable leads/documents JSON, and Automerge state.

### Requirement: Local merge transport

The system SHALL merge same-origin tab changes through Automerge without choosing a timestamp winner.

#### Scenario: Two tabs edit workspace

- **WHEN** two app tabs publish independent workspace changes
- **THEN** each tab merges the other tab's Automerge document
- **AND** both visible boards converge
- **AND** `updatedAt` does not decide the winner.

### Requirement: Experimental browser iroh transport

The system SHALL keep browser iroh transport behind an explicit experimental action and SHALL NOT report a connected peer before the browser WASM node starts and exposes an endpoint identity.

#### Scenario: Start browser iroh node

- **WHEN** the user opens Sync and starts iroh
- **THEN** the app starts the browser WASM adapter or shows its startup error
- **AND** a successful start shows the local endpoint identity
- **AND** no peer is claimed until pairing and an ALPN `match/sync/0` stream exist.

### Requirement: Flat WebMCP surface

The system SHALL expose imperative WebMCP tools that call the same domain commands as visible UI controls.

#### Scenario: Valid tool mutation updates visible state

- **WHEN** a supported browser calls `create_lead` with a valid flat payload
- **THEN** the tool returns the created card id and status
- **AND** the card is visible in the board.

#### Scenario: Tool rejects nested or unknown input

- **WHEN** a tool receives unknown fields or a CRDT-shaped nested payload
- **THEN** it rejects the input
- **AND** workspace state remains unchanged.
