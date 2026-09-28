# Proof transfer status

Implemented: bounded resumable proof pages; whole-record signatures retained; exact serialized budgets including envelope and authority evidence; candidate-derived dependency coverage; Rust authority/signature admission shared by WASM/native; optional untrusted restart cache; commit and document ACK remain after complete admission. Initial invitations, enrollment, and durable snapshot batches resolve manifests before validation/publication. Large proof-only authority changes send authority evidence without retransmitting history records. No proof/history retirement is implemented.

Legacy incoming v1 limits remain 20,000 records and 16 MiB. Pages use encoded frames ≤256 KiB, page payloads ≤224 KiB, requests ≤1,024 actual hashes, aggregate ≤1,000,000 records /256 MiB, and at most4,096 proof rounds. Oversized indivisible signed records or authority manifests reject. These finite resource caps still bound supported history. Paging only removes the legacy whole-bundle boundary; P2 growth/retirement work remains partially complete.

Compatibility: large outgoing bundles switch to a v2 manifest at64 KiB. No negotiated proof-v2 capability is implemented. All participants in a paged transfer must run this revision; old peers can reject bundles they previously accepted between64 KiB and legacy limits. Upgrade coordinated peers before rollout. Application rejection is terminal during invitation/enrollment; retry cannot make an old peer support the new format. Capability negotiation with explicit unsupported feedback remains required for mixed-version deployment.

## Reproduce CPU evidence

```
MATCH_PROOF_BENCHMARK=1 npm test -- src/sync/changeAuthorization.test.ts -t 'benchmarks complete'
```

Output `/tmp/match-proof-admission-benchmark.json`. Fixture uses a valid workspace, one real signed owner proof per actual change, and full production `validateIncomingChangeAuthorizations`; timing excludes signing/fixture construction. Counts and edit sequence fixed; generated identity varies. First unprofiled Node/Vitest WASM run, September28 2026:

| History/proofs | Aggregate bytes | Admission pages | Manifest export ms | Full TS/WASM admission ms | One-proof delta ms |
|---:|---:|---:|---:|---:|---:|
|100|98,765|1|22|64|25|
|1,000|976,365|5|29|482|176|
|20,001|19,522,341|96|678|9,947|3,179|

Metadata optimization keeps full actual history hash/dependency coverage and decodes operation bodies only for rejected unsigned discriminator repair. Same fixture after public `getChangesMetaSince(doc, [])` replaces eager binary decoding: full admission100/1,000/20,001 =58/453/9,156ms; one-proof delta =19/90/1,735ms. At20,001, delta improves3,179→1,735ms; full admission9,947→9,156ms. Rust/WASM flow and bridge remain dominant.

Delta has one additional change. Native release benchmark and commands live in `vendor/meta-mesh/docs/proof-paging.md`: at20,001, frozen source preparation544ms,98source pages343ms,full admission1,608ms,one-proof delta243ms. Different runtimes/fixtures; not direct browser latency estimates. Before metadata optimization, TS scanned and decoded every local/remote binary change. Current path still traverses complete metadata, merges/saves candidate, copies document bytes into JS arrays, crosses WASM, then verifies authority/coverage. Even a one-proof delta retains history-sized CPU cost. Main-thread animation stalls remain plausible; real-browser causation and connection flapping are unconfirmed. Worker isolation, incremental durable coverage indexing, and authenticated compaction need separate measured work.

## Proposed authenticated history checkpoint — not implemented

A safe checkpoint must have an explicit trust anchor: signed workspace genesis plus verified owner/succession chain, or a previously accepted checkpoint. Its canonical signed payload must bind workspace id, checkpoint sequence and predecessor digest, snapshot bytes digest, exact included history/frontier digest, authenticated causal coverage, and authority epoch. Owner signature alone cannot erase previously known competing authority chains or revocations.

Checkpoint authority evidence must retain authenticated ownership transitions, succession/quorum facts, device and person revocation boundaries, departures, grant epochs, and unresolved forks. Validation must prove included changes were authorized under their historical epoch and that no causal dependency was silently removed. A newer epoch cannot retroactively authorize an old unsigned change. Any compacted Automerge representation needs an explicit mapping between old hashes/frontiers and checkpoint coverage; no fabricated hash equivalence.

Agreed next history contract: signed snapshot baseline plus bounded undo tail (more than100 actions, exact tail policy pending measurements), with document epoch separate from ownership epoch and identity. A peer older than retained baseline must replace its local current state, including unsynced edits; it may explicitly fork its old copy into a new board. Old document epochs must never Automerge into the new epoch. Smart diff/rebase is deferred. Offline/old peers need versioned negotiated baseline support or terminal unsupported feedback. A route timeout, connection presence, or sender-claimed cursor is not durable coverage. Age alone does not define staleness:100tail actions can retire a baseline quickly.

Garbage collection may delete retired history only after checkpoint and authority evidence commit atomically, verified retained coverage proves every surviving document/dependency, and the explicitly designed forced-reset policy handles stale offline replicas while rollback protection remains verifiable. Page cache eviction remains separate. Interrupted compaction leaves either the full old durable snapshot+proofs or the fully verified new checkpoint+suffix. Failed validation, competing checkpoint chains, missing epochs, and publication failure preserve old state; no ACK/UI notification before atomic commit. Rollback protection needs persisted monotonic checkpoint sequence/digest plus conflict detection, not wall-clock timestamps.

Before implementation: specify authenticated coverage semantics against actual Automerge storage, threat-model stale/offline peers and malicious owners, extend TLA state for checkpoints/authority epochs/GC/rollback, produce counterexamples for premature deletion, and verify real Rust/WASM round trips with current plus stale versioned peers. No signed checkpoint or authority retirement is claimed by current finite paging models.

Future-board owner offers now register an exact frozen manifest source on the approved connection and existing authenticated secret, only while its offer is pending. Requests cannot select an arbitrary workspace, mutate that manifest, or reuse its registration on another connection. Browser recipients validate invitation authority before fetching and resolve all needed proofs before document admission or credential activation. Native recipients use an abortable nested transfer only after the product `prepare_owner_offer` hook verifies owner/controller and signed invitation policy; final `merge_owner_offer` still performs crypto admission and durable commit. Missing or forged pages emit no durable receipt. Successful receipts bind the original offer bytes, not the reconstructed aggregate proof bundle. Native timeout retries reuse untrusted cached pages with normal validation. `ownerOfferProofs.test.ts` and native `scope::tests` cover signed happy, missing, forged, unapproved, pending commit, and replay cases; product hook integration and real-route BDD remain required by consumers.
