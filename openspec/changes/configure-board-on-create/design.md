## Context

Workspace creation currently accepts a title and preset. Board structure already has a typed schema and shared validation. Configuration must be applied before genesis authorization and initial snapshot persistence, avoiding a visible intermediate preset board.

## Decisions

1. Keep title and preset immediately visible. Put structural customization behind an accessible disclosure with a concise summary.
2. Reuse existing schema types and validation; do not introduce another board configuration model or executable rules.
3. Support item name, ordered column editing, basic fields, required flags, and select options. Keep advanced settings in board editing.
4. Initialize from the selected preset. After manual editing, retain the custom draft across preset selection changes; any replacement requires an explicit reset action.
5. Construct and validate the final document before authorizing genesis and saving its initial snapshot. Publish the workspace only after successful persistence.
6. Retain the modal and draft on failure. Disable duplicate creation while pending, expose the error, and allow retry.
7. Use one scrollable content area with stable actions. Expanded desktop layout may widen; phone layout must remain within the viewport.

## Risks

- Removing seeded fields or columns can invalidate preset priority bindings or stage buttons; configuration must reconcile those references through existing domain validation.
- Initial JavaScript budget is close to its limit; defer configuration editor code where needed.
- Persistence consists of workspace snapshot and catalog/root registration; avoid reporting a successful board as a failed creation solely because later sync setup fails.

## Validation

Outer Given/When/Then tests cover configured creation on desktop and phone, custom item form fields, preset draft retention, invalid schema recovery, pending duplicate suppression, and persistence failure retry. Existing preset creation tests remain green. Run quality checks, size checks, and focused state tests for final genesis configuration.
