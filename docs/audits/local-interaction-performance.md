# Local card interaction audit

## Trigger and measured cause

Dragging a card, opening its detail, and typing could stall the main thread. Reported production observations were INP 1,784 ms and a footer layout shift of 0.4484. These are user observations, not measurements reproduced by this change.

The first explanation overemphasized whole-document transition comparison and persistence. An isolated Chromium CPU profile corrected that diagnosis. On a fixture with 55 cards containing 8,320-character descriptions, under 4× CPU slowdown:

- Workspace role resolution accumulated roughly 4,115 ms in the profiled interaction. Rust reconstructed authorization state from the serialized document on the main thread.
- History projection accumulated roughly 3,247 ms. `Automerge.getHistory` decoded operation payloads although the UI needed only change metadata.
- Snapshot loading accumulated roughly 949 ms across storage reads and commits.
- Transition comparison took roughly 3 ms; the domain command roughly 14 ms.

Inclusive profile costs overlap and cannot be added. The baseline longest main-thread task was 4,584 ms. The rewritten path's longest task was 53–71 ms across subsequent isolated runs. This is a synthetic regression measurement, not a production INP guarantee or a complete latency budget.

## Drag versus committed move

Sortable sends the domain move only from `onEnd`, after release. Pointer movement before release does not issue Automerge commands. Sortable layout and rendering remain a separate potential source of drag cost.

Previously, successful or failed moves incremented a board key, remounting the entire board to undo Sortable's direct DOM mutation. The adapter now remembers the original parent and next sibling, reads the proposed destination, restores the original DOM, and invokes the domain command. Vue then patches the committed move. Unaffected card and board DOM identities survive; failed storage restores placement and retry remains possible.

## Local command, storage, and authorization

Typed local moves retain cheap content/configuration permission checks plus domain parent, cycle, and archive validation. Editors still cannot move board columns. Whole-document transition validation remains on network admission, before an incoming candidate reaches durable storage.

Workspace access resolution runs in a dedicated worker. A bounded, 60-second cache keys results by document heads and full authority/identity evidence. Only the trusted local move path carries an existing result to its resulting heads. Changed authority, revocation evidence, ownership, or unrelated document heads force validation. Current authority is read again after the decision; a concurrent authority change rejects the result. Volatile persistence timestamps do not count as an authority change. Worker initialization failures reset the worker so a later attempt can recover.

Storage can clone the active document when its heads exactly match the stored snapshot. It still applies later journal changes. Mismatched heads load the durable snapshot. Modern active snapshot metadata avoids loading the previous snapshot solely to check archival state; archived and legacy metadata retain that guard. Existing transaction and cross-tab locking remain. Durable writes finish before success is published.

History reads now request change metadata, retaining attribution and action information without decoding every operation payload.

## Footer animation and limits

The decorative tower animation was tested together with working controls and unavailable permission validation. Its callbacks can be delayed by blocked main-thread work; the audit does not establish the animation itself as the expensive operation. No animation rewrite or claimed CLS fix is included.

Full snapshot serialization remains in persistence. Cache misses, cold startup, large unseen peer histories, and larger boards can still cost more. The measured fixture covers a specific detailed board, not arbitrary history size or the user's current production workspace.

## Verification

Outer browser scenarios cover detailed-card move and next interaction, durable reload, failed storage and retry, filtered moves, drag refresh/cancellation, unchanged neighboring DOM, footer animation, and unavailable access validation. Storage regressions cover unseen journal writes, newer snapshots from another tab, and reuse without consuming the borrowed document. Cache regressions cover fresh revocations and unrelated heads. Existing permission, forged-admission, archival, and overlapping-branch tests remain required.

Final verification: 754 unit tests passed (one skipped), 21 local browser scenarios passed, five replay/admission/footer scenarios passed, and two real owner/guest role scenarios passed. Concurrent two-tab move and neighbor edit both survived reload. Editor column moves were rejected. Static quality checks, MetaMesh pin verification, and production bundle budgets passed; initial JavaScript was 234.71 kB Brotli against the unchanged 235 kB limit.
