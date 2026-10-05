## ADDED Requirements

### Requirement: Stable default visual identity

The system SHALL derive a default illustrated avatar from a participant's stable person ID using a shared versioned deterministic algorithm. The same person SHALL retain the same avatar across devices, workspaces, display-name changes, and reloads. Default rendering SHALL work offline without external avatar requests or new replicated profile records.

#### Scenario: Same participant on two devices
- **GIVEN** two devices display messages from the same verified person ID
- **WHEN** their chat author headers render
- **THEN** both render the same avatar features and colors regardless of signing device ID.

#### Scenario: Rename and reload
- **GIVEN** a participant has a generated avatar
- **WHEN** their display name changes and the workspace reloads
- **THEN** the displayed name updates while their avatar stays the same.

### Requirement: Accessible author presentation

The system SHALL show avatars beside resolved author names in workspace chat and existing participant lists. Appearance SHALL NOT replace identity disambiguation, authorize actions, or imply online presence. Decorative avatars SHALL NOT duplicate adjacent author labels for assistive technology. Interactive avatar-only controls, if introduced later, SHALL have an accessible person label.

#### Scenario: Participants share a display name
- **GIVEN** two distinct person IDs have the same preferred name
- **WHEN** messages and participant rows render
- **THEN** existing name disambiguation remains visible beside their avatars
- **AND** visual similarity does not merge their identities or permissions.

#### Scenario: Participant offline
- **GIVEN** a known participant has no current online presence
- **WHEN** their message or participant row renders
- **THEN** their avatar remains visible without being presented as evidence that they are online.

#### Scenario: Narrow portrait chat
- **GIVEN** chat opens at 390 by 844 CSS pixels
- **WHEN** author headers and messages render
- **THEN** avatars and names remain readable without obscuring message controls or causing page-level horizontal clipping.

### Requirement: Safe grouping and fallback

The system SHALL retain correct author attribution when presentation groups consecutive messages. Grouping SHALL use person ID rather than display name and SHALL preserve each message's status and actions. Missing profiles SHALL retain person-derived avatars with existing fallback names; missing or invalid IDs SHALL render a neutral placeholder. Avatar rendering SHALL use trusted bounded primitives rather than untrusted markup.

#### Scenario: Consecutive messages from one person
- **GIVEN** adjacent messages share a person ID within the same presentation context
- **WHEN** author presentation groups them
- **THEN** a shared avatar/name header clearly attributes the group and every message retains its own status and actions.

#### Scenario: Profile unavailable
- **GIVEN** a retained message has a valid person ID but no available display profile
- **WHEN** the message renders offline
- **THEN** its deterministic avatar and existing fallback author name appear without waiting for a profile request.

#### Scenario: Send pending or failed
- **GIVEN** the current participant submits a message
- **WHEN** local persistence remains pending or fails
- **THEN** author presentation retains that participant's avatar
- **AND** pending status or failure feedback and recoverable draft remain visible.

#### Scenario: Invalid identity presentation input
- **GIVEN** an avatar component receives an empty or invalid person ID
- **WHEN** it renders
- **THEN** a neutral placeholder appears without executing markup or impersonating another participant.
