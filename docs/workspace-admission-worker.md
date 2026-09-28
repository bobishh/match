# Workspace admission worker

Browser `validateIncomingChangeAuthorizations` sends owned snapshot buffers and
normalized authorization evidence to one module Worker. The Worker initializes
Automerge and the Rust/WASM policy runtime, loads both snapshots, extracts complete
change metadata, verifies authorization coverage and signatures, and checks editor
transitions. Unsigned history is decoded only for the existing discriminator repair
classification. History is retained; this change does not truncate it.

The Worker cannot persist or acknowledge a candidate. The caller keeps the
workspace mutation lock across admission and the atomic document/proof commit.
Before accepting a Worker result it rereads durable authority and rejects a result
whose authority changed during validation. UI publication and the existing network
ACK remain downstream of successful persistence.

Snapshot buffers are transferred, not copied through integer arrays on the main
thread. Rust's document/metadata serialization runs inside the Worker. Existing
main-thread snapshot loading/saving, merge, authority lookup, proof object cloning,
local command authorization and transport state machines are not moved by this
change. A Worker is a browser thread; separate OS process placement is not promised.

Admission failures reject without a main-thread fallback. Startup errors, crashes
and a 60-second deadline reject queued work and permit a fresh Worker on retry.
Invalid authorization rejects only that job. Non-browser unit/CLI callers execute
the same pure admission algorithm with their installed policy runtime.

Validation:

- Real `/` route with 20,001 new signed changes: workspace menu visible in 59 ms
  while admission remained pending; successful commit survived reload. Fixture
  signatures cover groups of up to 256 hashes, so this is an interaction regression,
  not a repeat of the benchmark with 20,001 separate proof records.
- Real route with blocked Worker startup and a forged signature: durable document,
  stored proofs, UI heads and notification count stayed unchanged.
- Actual IndexedDB regressions cover concurrent tabs/peer branches and proof-write
  failure after admission; no partial publication.
- Unit regressions isolate authority changes while admission is pending, startup
  failure affecting queued jobs, timeout/late response and retry, and policy
  rejection followed by a valid job.

These checks use isolated local browser contexts, not production data.
