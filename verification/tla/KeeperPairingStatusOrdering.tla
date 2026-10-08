-------------------- MODULE KeeperPairingStatusOrdering --------------------
EXTENDS Naturals, TLC

CONSTANT IgnorePollFence

VARIABLES statusGeneration, uiStatus, pendingPoll, pendingPollGeneration, provisionCommitted
vars == <<statusGeneration, uiStatus, pendingPoll, pendingPollGeneration, provisionCommitted>>

Init ==
  /\ statusGeneration = 0
  /\ uiStatus = "pairing"
  /\ pendingPoll = FALSE
  /\ pendingPollGeneration = 0
  /\ provisionCommitted = FALSE

StartPendingPoll ==
  /\ ~pendingPoll
  /\ ~provisionCommitted
  /\ pendingPoll' = TRUE
  /\ pendingPollGeneration' = statusGeneration
  /\ UNCHANGED <<statusGeneration, uiStatus, provisionCommitted>>

CommitProvision ==
  /\ ~provisionCommitted
  /\ provisionCommitted' = TRUE
  /\ statusGeneration' = statusGeneration + 1
  /\ uiStatus' = "active"
  /\ UNCHANGED <<pendingPoll, pendingPollGeneration>>

ReturnPendingPoll ==
  /\ pendingPoll
  /\ pendingPoll' = FALSE
  /\ IF IgnorePollFence \/ pendingPollGeneration = statusGeneration
       THEN uiStatus' = "pairing"
       ELSE uiStatus' = uiStatus
  /\ UNCHANGED <<statusGeneration, pendingPollGeneration, provisionCommitted>>

Next == StartPendingPoll \/ CommitProvision \/ ReturnPendingPoll \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ statusGeneration \in Nat
  /\ uiStatus \in {"pairing", "active"}
  /\ pendingPoll \in BOOLEAN
  /\ pendingPollGeneration \in Nat
  /\ provisionCommitted \in BOOLEAN

CommittedProvisionStaysActive == provisionCommitted => uiStatus = "active"

=============================================================================
