-------------------- MODULE KeeperIntegrationSettings --------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS CurrentBoard, UnselectedBoard, AddedBoard, FutureBoard, RequireDualApproval,
          EnforceRevisionCAS, BaselineRemovedBoard

VARIABLES active, grantEpochs, tombstones, baseline, futureBoards, revision,
          pending, ownerApproved, operatorApproved, staleCommit, unpairedCommit

vars == <<active, grantEpochs, tombstones, baseline, futureBoards, revision,
         pending, ownerApproved, operatorApproved, staleCommit, unpairedCommit>>
BoardSet == {CurrentBoard, UnselectedBoard, AddedBoard, FutureBoard}

Init ==
  /\ active = {CurrentBoard, UnselectedBoard}
  /\ grantEpochs = [b \in BoardSet |-> CASE b = CurrentBoard -> 4
                                               [] b = UnselectedBoard -> 2
                                               [] OTHER -> 0]
  /\ tombstones = [b \in BoardSet |-> IF b = AddedBoard THEN 3 ELSE 0]
  /\ baseline = {CurrentBoard, UnselectedBoard}
  /\ futureBoards = TRUE
  /\ revision = 1
  /\ pending = FALSE
  /\ ownerApproved = FALSE
  /\ operatorApproved = FALSE
  /\ staleCommit = FALSE
  /\ unpairedCommit = FALSE

StartExpansion ==
  /\ ~pending
  /\ revision < 4
  /\ pending' = TRUE
  /\ ownerApproved' = TRUE
  /\ operatorApproved' = FALSE
  /\ UNCHANGED <<active, grantEpochs, tombstones, baseline, futureBoards, revision,
                  staleCommit, unpairedCommit>>

OperatorApproves ==
  /\ pending
  /\ ~operatorApproved
  /\ operatorApproved' = TRUE
  /\ UNCHANGED <<active, grantEpochs, tombstones, baseline, futureBoards, revision,
                  pending, ownerApproved, staleCommit, unpairedCommit>>

TurnFutureOff ==
  /\ futureBoards
  /\ revision < 4
  /\ futureBoards' = FALSE
  /\ revision' = revision + 1
  /\ UNCHANGED <<active, grantEpochs, tombstones, baseline, pending,
                  ownerApproved, operatorApproved, staleCommit, unpairedCommit>>

EnableFutureDual ==
  /\ ~futureBoards
  /\ revision < 4
  /\ ownerApproved
  /\ operatorApproved
  /\ futureBoards' = TRUE
  /\ baseline' = baseline \cup active \cup {CurrentBoard, UnselectedBoard, FutureBoard}
  /\ revision' = revision + 1
  /\ UNCHANGED <<active, grantEpochs, tombstones, pending,
                  ownerApproved, operatorApproved, staleCommit, unpairedCommit>>

CommitExpansion ==
  /\ pending
  /\ ownerApproved
  /\ (~RequireDualApproval \/ operatorApproved)
  /\ (~EnforceRevisionCAS \/ revision = 1)
  /\ AddedBoard \notin active
  /\ revision < 4
  /\ grantEpochs' = [grantEpochs EXCEPT ![AddedBoard] = 4]
  /\ active' = active \cup {AddedBoard}
  /\ pending' = FALSE
  /\ staleCommit' = IF revision = 1 THEN staleCommit ELSE TRUE
  /\ unpairedCommit' = IF operatorApproved THEN unpairedCommit ELSE TRUE
  /\ revision' = revision + 1
  /\ UNCHANGED <<tombstones, baseline, futureBoards, ownerApproved, operatorApproved>>

RemoveCurrentScope ==
  /\ FutureBoard \in active
  /\ revision < 4
  /\ active' = active \ {FutureBoard}
  /\ grantEpochs' = [grantEpochs EXCEPT ![FutureBoard] = 0]
  /\ tombstones' = [tombstones EXCEPT ![FutureBoard] = grantEpochs[FutureBoard]]
  /\ baseline' = IF futureBoards /\ BaselineRemovedBoard
                    THEN baseline \cup {FutureBoard}
                    ELSE baseline
  /\ revision' = revision + 1
  /\ UNCHANGED <<futureBoards, pending, ownerApproved, operatorApproved,
                  staleCommit, unpairedCommit>>

OfferFutureBoard ==
  /\ futureBoards
  /\ revision < 4
  /\ FutureBoard \notin baseline
  /\ FutureBoard \notin active
  /\ grantEpochs' = [grantEpochs EXCEPT ![FutureBoard] = 4]
  /\ active' = active \cup {FutureBoard}
  /\ revision' = revision + 1
  /\ UNCHANGED <<tombstones, baseline, futureBoards, pending,
                  ownerApproved, operatorApproved, staleCommit, unpairedCommit>>

Next == StartExpansion \/ OperatorApproves \/ TurnFutureOff \/ EnableFutureDual
        \/ CommitExpansion \/ RemoveCurrentScope \/ OfferFutureBoard \/ UNCHANGED vars

TypeOK ==
  /\ active \subseteq BoardSet
  /\ grantEpochs \in [ BoardSet -> Nat ]
  /\ tombstones \in [ BoardSet -> Nat ]
  /\ baseline \subseteq BoardSet
  /\ futureBoards \in BOOLEAN
  /\ revision \in Nat
  /\ pending \in BOOLEAN
  /\ ownerApproved \in BOOLEAN
  /\ operatorApproved \in BOOLEAN
  /\ staleCommit \in BOOLEAN
  /\ unpairedCommit \in BOOLEAN

ActiveGrantBeatsTombstone ==
  \A board \in active : grantEpochs[board] > (IF board \in DOMAIN tombstones THEN tombstones[board] ELSE 0)

PendingPreservesOldScopes == pending => {CurrentBoard, UnselectedBoard} \subseteq active
ExpansionRequiresTwoApprovals == ~unpairedCommit
StaleExpansionRejected == ~staleCommit
RemovedBoardCannotAutoReadd == tombstones[FutureBoard] > 0 =>
  (FutureBoard \in baseline \/ ~futureBoards)
ExistingUnselectedBoardExcluded == futureBoards => UnselectedBoard \in baseline

Spec == Init /\ [][Next]_vars

=============================================================================
