-------------------- MODULE OwnerRevocationPersistence --------------------
EXTENDS Naturals, TLC

CONSTANT RawHeadOnly

VARIABLES boundarySigned, signedHeadSource, authorityHasRevocation,
          keeperRevoked, removalComplete, ownerRole, reloadObserved,
          attemptInterrupted, restarted
vars == <<boundarySigned, signedHeadSource, authorityHasRevocation,
          keeperRevoked, removalComplete, ownerRole, reloadObserved,
          attemptInterrupted, restarted>>

AdmittedHeadExists == TRUE
RawQuarantinedHeadExists == TRUE
AdmittedDocumentHasQuarantine == FALSE

Init ==
  /\ boundarySigned = FALSE
  /\ signedHeadSource = "none"
  /\ authorityHasRevocation = FALSE
  /\ keeperRevoked = FALSE
  /\ removalComplete = FALSE
  /\ ownerRole = "owner"
  /\ reloadObserved = FALSE
  /\ attemptInterrupted = FALSE
  /\ restarted = FALSE

SignBoundary ==
  /\ ~boundarySigned
  /\ IF RawHeadOnly THEN RawQuarantinedHeadExists ELSE AdmittedHeadExists
  /\ signedHeadSource' = IF RawHeadOnly THEN "raw-quarantined" ELSE "admitted"
  /\ boundarySigned' = TRUE
  /\ UNCHANGED <<authorityHasRevocation, keeperRevoked, removalComplete,
                  ownerRole, reloadObserved, attemptInterrupted, restarted>>

PersistBoundary ==
  /\ boundarySigned
  /\ ~authorityHasRevocation
  /\ (~attemptInterrupted \/ restarted)
  /\ authorityHasRevocation' = TRUE
  /\ attemptInterrupted' = FALSE
  /\ UNCHANGED <<boundarySigned, signedHeadSource, keeperRevoked,
                  removalComplete, ownerRole, reloadObserved, restarted>>

FailBeforePersistence ==
  /\ boundarySigned
  /\ ~authorityHasRevocation
  /\ ~attemptInterrupted
  /\ attemptInterrupted' = TRUE
  /\ UNCHANGED <<boundarySigned, signedHeadSource, authorityHasRevocation,
                  keeperRevoked, removalComplete, ownerRole, reloadObserved, restarted>>

Restart ==
  /\ attemptInterrupted
  /\ ~restarted
  /\ restarted' = TRUE
  /\ UNCHANGED <<boundarySigned, signedHeadSource, authorityHasRevocation,
                  keeperRevoked, removalComplete, ownerRole, reloadObserved, attemptInterrupted>>

RevokeKeeper ==
  /\ authorityHasRevocation
  /\ (signedHeadSource = "admitted" \/ RawHeadOnly)
  /\ ~keeperRevoked
  /\ keeperRevoked' = TRUE
  /\ removalComplete' = TRUE
  /\ UNCHANGED <<boundarySigned, signedHeadSource, authorityHasRevocation,
                  ownerRole, reloadObserved, attemptInterrupted, restarted>>

Reload ==
  /\ removalComplete
  /\ ownerRole' = IF authorityHasRevocation /\ signedHeadSource # "admitted"
                     THEN "unavailable"
                     ELSE "owner"
  /\ reloadObserved' = TRUE
  /\ UNCHANGED <<boundarySigned, signedHeadSource, authorityHasRevocation,
                  keeperRevoked, removalComplete, attemptInterrupted, restarted>>

Next == SignBoundary \/ PersistBoundary \/ FailBeforePersistence \/ Restart \/ RevokeKeeper \/ Reload

TypeOK ==
  /\ boundarySigned \in BOOLEAN
  /\ signedHeadSource \in {"none", "admitted", "raw-quarantined"}
  /\ authorityHasRevocation \in BOOLEAN
  /\ keeperRevoked \in BOOLEAN
  /\ removalComplete \in BOOLEAN
  /\ ownerRole \in {"owner", "unavailable"}
  /\ reloadObserved \in BOOLEAN
  /\ attemptInterrupted \in BOOLEAN
  /\ restarted \in BOOLEAN

NoQuarantineAdmission == ~AdmittedDocumentHasQuarantine
NoFalseRemovalCompletion == removalComplete => authorityHasRevocation /\ signedHeadSource = "admitted"
OwnerAccessSurvivesOtherKeeperRemoval == removalComplete /\ reloadObserved => ownerRole = "owner"
OwnerAuthorityRemainsAvailable == ownerRole = "owner"

Spec == Init /\ [][Next]_vars

=============================================================================
