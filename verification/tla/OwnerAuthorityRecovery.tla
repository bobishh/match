-------------------- MODULE OwnerAuthorityRecovery --------------------
EXTENDS Naturals, TLC

CONSTANTS AcceptUnauthorizedRecovery, AcceptRevokedDeviceRecovery

VARIABLES currentOwnerMatches, repairActorIsOwner, currentDeviceRevoked, oldRecordSignedByOwner,
          oldBoundaryInAdmittedDoc, replacementUsesAdmittedHead,
          latestRevocationEpoch, targetGrantEpoch, targetRevoked,
          oldBoundaryHistoryPreserved, casConflict, repairCommitted,
          ownerRole, reloadObserved, restarted
vars == <<currentOwnerMatches, repairActorIsOwner, currentDeviceRevoked, oldRecordSignedByOwner,
          oldBoundaryInAdmittedDoc, replacementUsesAdmittedHead,
          latestRevocationEpoch, targetGrantEpoch, targetRevoked,
          oldBoundaryHistoryPreserved, casConflict, repairCommitted,
          ownerRole, reloadObserved, restarted>>

Init ==
  /\ currentOwnerMatches = TRUE
  /\ repairActorIsOwner = ~AcceptUnauthorizedRecovery
  /\ currentDeviceRevoked = AcceptRevokedDeviceRecovery
  /\ oldRecordSignedByOwner = TRUE
  /\ oldBoundaryInAdmittedDoc = FALSE
  /\ replacementUsesAdmittedHead = FALSE
  /\ latestRevocationEpoch = 6
  /\ targetGrantEpoch = 5
  /\ targetRevoked = FALSE
  /\ oldBoundaryHistoryPreserved = FALSE
  /\ casConflict = FALSE
  /\ repairCommitted = FALSE
  /\ ownerRole = "unavailable"
  /\ reloadObserved = FALSE
  /\ restarted = FALSE

CASConflict ==
  /\ ~repairCommitted
  /\ ~casConflict
  /\ casConflict' = TRUE
  /\ UNCHANGED <<currentOwnerMatches, repairActorIsOwner, currentDeviceRevoked, oldRecordSignedByOwner,
                  oldBoundaryInAdmittedDoc, replacementUsesAdmittedHead,
                  latestRevocationEpoch, targetGrantEpoch, targetRevoked,
                  oldBoundaryHistoryPreserved, repairCommitted, ownerRole,
                  reloadObserved, restarted>>

RestartAndRefreshRevision ==
  /\ casConflict
  /\ ~restarted
  /\ casConflict' = FALSE
  /\ restarted' = TRUE
  /\ UNCHANGED <<currentOwnerMatches, repairActorIsOwner, currentDeviceRevoked, oldRecordSignedByOwner,
                  oldBoundaryInAdmittedDoc, replacementUsesAdmittedHead,
                  latestRevocationEpoch, targetGrantEpoch, targetRevoked,
                  oldBoundaryHistoryPreserved, repairCommitted, ownerRole, reloadObserved>>

RepairRevocation ==
  /\ ~repairCommitted
  /\ ~casConflict
  /\ currentOwnerMatches
  /\ (repairActorIsOwner \/ AcceptUnauthorizedRecovery)
  /\ (~currentDeviceRevoked \/ AcceptRevokedDeviceRecovery)
  /\ oldRecordSignedByOwner
  /\ ~oldBoundaryInAdmittedDoc
  /\ latestRevocationEpoch = 6
  /\ latestRevocationEpoch' = 7
  /\ replacementUsesAdmittedHead' = TRUE
  /\ targetRevoked' = TRUE
  /\ oldBoundaryHistoryPreserved' = TRUE
  /\ repairCommitted' = TRUE
  /\ UNCHANGED <<currentOwnerMatches, repairActorIsOwner, currentDeviceRevoked, oldRecordSignedByOwner,
                  oldBoundaryInAdmittedDoc, targetGrantEpoch, casConflict,
                  ownerRole, reloadObserved, restarted>>

Reload ==
  /\ repairCommitted
  /\ ownerRole' = IF replacementUsesAdmittedHead THEN "owner" ELSE "unavailable"
  /\ reloadObserved' = TRUE
  /\ UNCHANGED <<currentOwnerMatches, repairActorIsOwner, currentDeviceRevoked, oldRecordSignedByOwner,
                  oldBoundaryInAdmittedDoc, replacementUsesAdmittedHead,
                  latestRevocationEpoch, targetGrantEpoch, targetRevoked,
                  oldBoundaryHistoryPreserved, casConflict, repairCommitted, restarted>>

Next == CASConflict \/ RestartAndRefreshRevision \/ RepairRevocation \/ Reload \/ UNCHANGED vars

TypeOK ==
  /\ currentOwnerMatches \in BOOLEAN
  /\ repairActorIsOwner \in BOOLEAN
  /\ currentDeviceRevoked \in BOOLEAN
  /\ oldRecordSignedByOwner \in BOOLEAN
  /\ oldBoundaryInAdmittedDoc \in BOOLEAN
  /\ replacementUsesAdmittedHead \in BOOLEAN
  /\ latestRevocationEpoch \in {6, 7}
  /\ targetGrantEpoch = 5
  /\ targetRevoked \in BOOLEAN
  /\ oldBoundaryHistoryPreserved \in BOOLEAN
  /\ casConflict \in BOOLEAN
  /\ repairCommitted \in BOOLEAN
  /\ ownerRole \in {"owner", "unavailable"}
  /\ reloadObserved \in BOOLEAN
  /\ restarted \in BOOLEAN

OnlyCurrentOwnerRepairs == repairCommitted => repairActorIsOwner /\ currentOwnerMatches
OnlyAuthorizedOwnerDeviceRepairs == repairCommitted => repairActorIsOwner /\ currentOwnerMatches /\ ~currentDeviceRevoked
RepairRetainsOldBoundaryHistory == repairCommitted => oldBoundaryHistoryPreserved
RepairUsesAdmittedHead == repairCommitted => replacementUsesAdmittedHead
RetryRevokesCurrentGrant == reloadObserved => latestRevocationEpoch > targetGrantEpoch /\ targetRevoked
RepairRestoresOwnerAfterReload == repairCommitted /\ reloadObserved => ownerRole = "owner"
CASConflictDoesNotCommit == casConflict => ~repairCommitted

Spec == Init /\ [][Next]_vars

=============================================================================
