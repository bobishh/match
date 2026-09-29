------------------------- MODULE WorkspaceCommit -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Operations, Serialized, Atomic
ASSUME /\ Operations # {} /\ "none" \notin Operations
       /\ Serialized \in BOOLEAN /\ Atomic \in BOOLEAN

VARIABLES phase, base, snapshot, proofs, accepted, committed, published,
          attemptPublished, receipts, retryUsed, lock
vars == <<phase, base, snapshot, proofs, accepted, committed, published,
          attemptPublished, receipts, retryUsed, lock>>

Init == /\ phase = [o \in Operations |-> "idle"]
        /\ base = [o \in Operations |-> {}]
        /\ snapshot = {} /\ proofs = {} /\ accepted = {}
        /\ committed = {} /\ published = {}
        /\ attemptPublished = [o \in Operations |-> FALSE]
        /\ receipts = [o \in Operations |-> 0]
        /\ retryUsed = {} /\ lock = "none"

Read(o) == /\ phase[o] = "idle"
           /\ ~Serialized \/ lock = "none"
           /\ phase' = [phase EXCEPT ![o] = "prepared"]
           /\ base' = [base EXCEPT ![o] = snapshot]
           /\ lock' = IF Serialized THEN o ELSE lock
           /\ UNCHANGED <<snapshot, proofs, accepted, committed, published,
                          attemptPublished, receipts, retryUsed>>

Commit(o) == /\ phase[o] = "prepared"
             /\ snapshot' = base[o] \cup {o}
             /\ accepted' = accepted \cup {o}
             /\ phase' = [phase EXCEPT ![o] = IF Atomic THEN "committed" ELSE "saved"]
             /\ proofs' = IF Atomic THEN proofs \cup {o} ELSE proofs
             /\ committed' = IF Atomic THEN committed \cup {o} ELSE committed
             /\ receipts' = IF Atomic THEN [receipts EXCEPT ![o] = 1] ELSE receipts
             /\ UNCHANGED <<base, published, attemptPublished, retryUsed, lock>>

Publish(o) == /\ phase[o] \in {"saved", "committed"}
              /\ published' = published \cup {o}
              /\ attemptPublished' = [attemptPublished EXCEPT ![o] = TRUE]
              /\ phase' = [phase EXCEPT ![o] = IF Atomic THEN "done" ELSE "proof"]
              /\ lock' = IF Atomic /\ Serialized THEN "none" ELSE lock
              /\ UNCHANGED <<base, snapshot, proofs, accepted, committed, receipts, retryUsed>>

SaveProof(o) == /\ ~Atomic /\ phase[o] = "proof"
                /\ proofs' = proofs \cup {o}
                /\ committed' = committed \cup {o}
                /\ receipts' = [receipts EXCEPT ![o] = 1]
                /\ phase' = [phase EXCEPT ![o] = "done"]
                /\ lock' = IF Serialized THEN "none" ELSE lock
                /\ UNCHANGED <<base, snapshot, accepted, published, attemptPublished, retryUsed>>

Abort(o) == /\ phase[o] \in {"prepared", "proof"}
            /\ phase' = [phase EXCEPT ![o] = "aborted"]
            /\ lock' = IF Serialized THEN "none" ELSE lock
            /\ UNCHANGED <<base, snapshot, proofs, accepted, committed,
                           published, attemptPublished, receipts, retryUsed>>

CrashAfterCommit(o) == /\ Atomic /\ phase[o] = "committed"
                       /\ phase' = [phase EXCEPT ![o] = "done"]
                       /\ lock' = IF Serialized THEN "none" ELSE lock
                       /\ UNCHANGED <<base, snapshot, proofs, accepted, committed,
                                      published, attemptPublished, receipts, retryUsed>>

Retry(o) == /\ phase[o] \in {"done", "aborted"} /\ o \notin retryUsed
            /\ phase' = [phase EXCEPT ![o] = "idle"]
            /\ attemptPublished' = [attemptPublished EXCEPT ![o] = FALSE]
            /\ retryUsed' = retryUsed \cup {o}
            /\ UNCHANGED <<base, snapshot, proofs, accepted, committed, published, receipts, lock>>

Next == \E o \in Operations:
          Read(o) \/ Commit(o) \/ Publish(o) \/ SaveProof(o) \/ Abort(o)
          \/ CrashAfterCommit(o) \/ Retry(o)
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in [Operations -> {"idle", "prepared", "saved", "proof", "committed", "done", "aborted"}]
          /\ base \in [Operations -> SUBSET Operations]
          /\ snapshot \subseteq Operations /\ proofs \subseteq Operations
          /\ accepted \subseteq Operations /\ committed \subseteq Operations
          /\ published \subseteq Operations /\ retryUsed \subseteq Operations
          /\ attemptPublished \in [Operations -> BOOLEAN]
          /\ receipts \in [Operations -> 0..1]
          /\ lock \in Operations \cup {"none"}
DurableBranchesRetained == accepted \subseteq snapshot
SuccessfulCommitRetained == committed \subseteq snapshot
ProofCoverage == snapshot \subseteq proofs
NotificationAfterCommit == published \subseteq committed
AbortedSilent == \A o \in Operations: phase[o] = "aborted" => ~attemptPublished[o]
ReceiptIdempotency == \A o \in Operations: receipts[o] = IF o \in committed THEN 1 ELSE 0
SharedWorkspaceLock == Serialized =>
  Cardinality({o \in Operations: phase[o] \in {"prepared", "committed", "saved", "proof"}}) <= 1
=============================================================================
