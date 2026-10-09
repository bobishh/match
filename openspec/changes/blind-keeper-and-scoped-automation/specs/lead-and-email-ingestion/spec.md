## ADDED Requirements

### Requirement: Preserve website lead intake with Clef
Worker automation SHALL preserve existing bounded form intake, single-use human-check semantics, durable pending acknowledgement, supplied-field precedence, bounded public JobPosting/OpenGraph extraction, relevance/role/seniority decision distributions and chat evidence. Clef-flash SHALL replace Jev without silently changing card eligibility policy.

#### Scenario: Relevant complete vacancy
- **GIVEN** valid intake with a concrete vacancy, company, role and job URL
- **WHEN** Clef returns job_opportunity yes under the approved policy
- **THEN** automation creates one signed Lead in the current status.lead binding and records source and all decision distributions.

#### Scenario: Unrelated or incomplete intake
- **WHEN** accepted intake is unrelated, uncertain or lacks required vacancy fields
- **THEN** source/decision evidence remains available in chat/review and no invented Lead is created.

#### Scenario: Expired human check or failed durable save
- **WHEN** the human check is expired/incorrect or intake cannot persist
- **THEN** intake returns a specific failure and never claims durable acceptance.

#### Scenario: Classifier unavailable
- **WHEN** Clef is unavailable or returns an invalid distribution
- **THEN** the durable event remains retryable and is not marked applied.

### Requirement: Forwarded email selects an approved integration
Email intake SHALL map an integration-specific forwarding address to an approved source/workspace, validate bounded MIME bodies/attachments and preserve source/thread identity. Sender-supplied target IDs SHALL NOT expand access. Forwarding confirmation mail SHALL be visible to the owner.

#### Scenario: Valid forwarded message
- **WHEN** a configured source receives a bounded message
- **THEN** it saves the event durably and exposes pending classification and original source evidence.

#### Scenario: Injected destination
- **WHEN** message content names an unapproved board or integration
- **THEN** routing remains bound to the configured recipient integration and no cross-board mutation occurs.

### Requirement: Correlate specific applications before status changes
Automation SHALL correlate email to one application using persisted thread/reference/job-URL or sufficient company-and-role context. Company alone SHALL NOT establish a unique link. Unmatched new opportunities MAY create Leads only under explicit creation policy; unmatched refusals/interviews SHALL require review.

#### Scenario: Two vacancies at one company
- **GIVEN** two existing cards for distinct roles at the same company
- **WHEN** a refusal has no evidence distinguishing them
- **THEN** neither card moves and the event enters review with candidate matches.

#### Scenario: Bound application thread
- **GIVEN** a verified source thread mapping to one eligible application
- **WHEN** a later message arrives in that thread
- **THEN** classification evaluates that card's permitted context without creating a duplicate Lead.

### Requirement: Clear email events move existing cards
After explicit integration approval, automation SHALL classify application_event using typed choices and stored probabilities. Unambiguously matched interview/rejected events satisfying the approved threshold/margin SHALL append source evidence and apply authorized moveEntity to current status.interview/status.rejected entity bindings. Rejected SHALL NOT mean archived. Invalid/ambiguous results SHALL require review.

#### Scenario: Interview invitation
- **GIVEN** an eligible Applied card and a uniquely matched interview invitation satisfying policy
- **WHEN** automation processes it with human clients closed
- **THEN** the same card moves to the bound Interview column with source/decision history, and another client later verifies the signed change.

#### Scenario: Refusal
- **GIVEN** an eligible card and a uniquely matched refusal satisfying policy
- **WHEN** automation processes it
- **THEN** the same card moves to Rejected without archiving or replacing its human narrative.

#### Scenario: Column renamed or missing
- **WHEN** a configured status column is renamed
- **THEN** its stable binding ID continues to route moves; a missing/deleted binding instead pauses the action visibly.

### Requirement: Preserve newer human and event decisions
Automatic status transitions MUST bind expected status/placement revision and causal frontier. Old events, concurrent manual changes and ambiguous causal order SHALL NOT silently overwrite a newer decision. Receivers MUST preserve this rule on branch reconciliation. Event timestamps alone SHALL NOT establish precedence.

#### Scenario: Manual move during processing
- **GIVEN** automation classified an email against a prior card status
- **WHEN** a human moves that card before application or on a concurrent offline branch
- **THEN** the conflicting automation move enters review/reconciliation rather than silently overriding the human decision.

#### Scenario: New interview after rejection
- **GIVEN** a card is Rejected
- **WHEN** newer uniquely correlated evidence establishes an interview and policy permits the transition
- **THEN** it may move to Interview; no fixed numerical status ordering forbids the transition.

#### Scenario: Old email replay
- **WHEN** a previously applied or causally older email is forwarded again
- **THEN** it does not duplicate evidence or roll back current status.

### Requirement: Cutover preserves old intake identities
Migration SHALL preserve legacy pending/results IDs, card IDs and terminal processing outcomes, move extraction/classification/authorship outside blind Keeper and expose a per-source journal with pending/review/applied/failed/revoked states.

#### Scenario: Imported terminal result
- **GIVEN** a legacy card_created_v2 or chat_queued result
- **WHEN** it is imported/retried after cutover
- **THEN** existing card/evidence remains linked and no duplicate is created.

#### Scenario: Pending old inbox
- **WHEN** intake cutover happens with awaiting_mesh events
- **THEN** those events resume under independent automation with original IDs; blind Keeper receives neither raw inbox nor inference secrets.
