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

### Requirement: Bounded custom avatar profiles

The system SHALL let a participant crop a local photo to a metadata-free 128 × 128 WebP or JPEG no larger than 16 KiB and save it inline in the workspace Automerge document. Avatar bytes and changed timestamp SHALL be one profile scalar under a deterministic per-person entity key so independent profile creation cannot replace another participant's profile. A verified change proof SHALL authorize mutations and removal only for its own person ID; visitors SHALL NOT gain authority over workspace content or another profile. A missing custom photo SHALL use the deterministic default avatar. The browser SHALL not upload photos to a separate blob service.

#### Scenario: Crop and save profile photo
- **GIVEN** a participant opens identity settings and chooses a supported local image
- **WHEN** they select a circular crop area and save it
- **THEN** a 128 × 128 WebP or JPEG no larger than 16 KiB is stored in their workspace CRDT profile
- **AND** the photo remains visible after reload and on a peer that receives the CRDT change.

#### Scenario: Invalid or oversized photo
- **GIVEN** a participant chooses an undecodable, unsupported, or over-limit source image
- **WHEN** the cropper validates or encodes it
- **THEN** it shows an error without changing the saved avatar.

#### Scenario: Storage failure preserves draft
- **GIVEN** a valid cropped photo is ready to save
- **WHEN** local persistence fails
- **THEN** the old profile photo remains authoritative and the crop draft remains available for retry.

#### Scenario: Visitor changes own profile
- **GIVEN** a verified visitor has a `chat.profile` grant
- **WHEN** they add or remove their own profile avatar
- **THEN** the change is admitted for their person ID
- **AND** edits to workspace content or another participant's profile remain rejected.

#### Scenario: Concurrent first profiles
- **GIVEN** two participants create their first photo profiles from the same legacy workspace heads
- **WHEN** their CRDT changes merge
- **THEN** both per-person profile records remain present.
