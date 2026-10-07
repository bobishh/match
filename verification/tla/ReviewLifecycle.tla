------------------------- MODULE ReviewLifecycle -------------------------
EXTENDS Naturals, TLC

CONSTANTS SkipDecisionGuard, EraseOnDismiss
ASSUME /\ SkipDecisionGuard \in BOOLEAN
       /\ EraseOnDismiss \in BOOLEAN

VARIABLES sourceDecision, resolutionCommitted, resolutionReceipt,
          derivedChangeAdmitted, rowState, proofRetained, rawChangePresent,
          rawChangeAdmitted, cloneReady, committedTrusted, commandCount,
          lock, actionError, dismissalLocal, dismissalPersisted,
          dismissalPending
vars == <<sourceDecision, resolutionCommitted, resolutionReceipt,
          derivedChangeAdmitted, rowState, proofRetained, rawChangePresent,
          rawChangeAdmitted, cloneReady, committedTrusted, commandCount,
          lock, actionError, dismissalLocal, dismissalPersisted,
          dismissalPending>>

Init == /\ sourceDecision = "quarantined"
        /\ resolutionCommitted = FALSE
        /\ resolutionReceipt = FALSE
        /\ derivedChangeAdmitted = FALSE
        /\ rowState = "pending"
        /\ proofRetained = TRUE
        /\ rawChangePresent = TRUE
        /\ rawChangeAdmitted = FALSE
        /\ cloneReady = FALSE
        /\ committedTrusted = FALSE
        /\ commandCount = 0
        /\ lock = FALSE
        /\ actionError = FALSE
        /\ dismissalLocal = FALSE
        /\ dismissalPersisted = FALSE
        /\ dismissalPending = FALSE

DismissRow == /\ sourceDecision = "quarantined"
              /\ ~resolutionCommitted
              /\ rowState = "pending"
              /\ rowState' = "dismissed"
              /\ proofRetained' = IF EraseOnDismiss THEN FALSE ELSE proofRetained
              /\ rawChangePresent' = IF EraseOnDismiss THEN FALSE ELSE rawChangePresent
              /\ dismissalLocal' = TRUE
              /\ dismissalPending' = TRUE
              /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                             derivedChangeAdmitted, rawChangeAdmitted, cloneReady, committedTrusted,
                             commandCount, lock, actionError,
                             dismissalPersisted>>

SaveDismissal == /\ dismissalPending
                 /\ dismissalPersisted' = TRUE
                 /\ dismissalPending' = FALSE
                 /\ actionError' = FALSE
                 /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                                derivedChangeAdmitted, rowState, proofRetained,
                                rawChangePresent, rawChangeAdmitted,
                                cloneReady, committedTrusted, commandCount,
                                lock, dismissalLocal>>

FailDismissalSave == /\ dismissalPending
                     /\ dismissalPending' = FALSE
                     /\ actionError' = TRUE
                     /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                                    derivedChangeAdmitted, rowState, proofRetained,
                                    rawChangePresent, rawChangeAdmitted,
                                    cloneReady, committedTrusted, commandCount,
                                    lock, dismissalLocal, dismissalPersisted>>

RetryDismissalSave == /\ dismissalLocal
                      /\ ~dismissalPersisted
                      /\ ~dismissalPending
                      /\ dismissalPending' = TRUE
                      /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                                     derivedChangeAdmitted, rowState, proofRetained,
                                     rawChangePresent, rawChangeAdmitted,
                                     cloneReady, committedTrusted, commandCount,
                                     lock, actionError, dismissalLocal,
                                     dismissalPersisted>>

DismissError == /\ actionError
                /\ actionError' = FALSE
                /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                               derivedChangeAdmitted, rowState, proofRetained,
                               rawChangePresent, rawChangeAdmitted,
                               cloneReady, committedTrusted, commandCount,
                               lock, dismissalLocal, dismissalPersisted,
                               dismissalPending>>

Reload == /\ rowState' = IF resolutionCommitted THEN "resolved"
                           ELSE IF dismissalPersisted THEN "dismissed" ELSE "pending"
          /\ dismissalLocal' = dismissalPersisted
          /\ dismissalPending' = FALSE
          /\ actionError' = FALSE
          /\ cloneReady' = FALSE
          /\ lock' = FALSE
          /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                         derivedChangeAdmitted, proofRetained, rawChangePresent,
                         rawChangeAdmitted, committedTrusted, commandCount,
                         dismissalPersisted>>

PrepareTrustedClone == /\ (~resolutionCommitted \/ SkipDecisionGuard)
                      /\ ~cloneReady
                      /\ cloneReady' = TRUE
                      /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                                     derivedChangeAdmitted, rowState, proofRetained,
                                     rawChangePresent, rawChangeAdmitted,
                                     committedTrusted, commandCount, lock,
                                     actionError, dismissalLocal,
                                     dismissalPersisted, dismissalPending>>

StartReview == /\ ~lock
               /\ cloneReady
               /\ (~resolutionCommitted \/ SkipDecisionGuard)
               /\ lock' = TRUE
               /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                              derivedChangeAdmitted, rowState, proofRetained,
                              rawChangePresent, rawChangeAdmitted,
                              cloneReady, committedTrusted, commandCount,
                              actionError, dismissalLocal,
                              dismissalPersisted, dismissalPending>>

FailReviewPersistence == /\ lock
                        /\ lock' = FALSE
                        /\ cloneReady' = FALSE
                        /\ actionError' = TRUE
                        /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                                       derivedChangeAdmitted, rowState, proofRetained,
                                       rawChangePresent, rawChangeAdmitted,
                                       committedTrusted, commandCount,
                                       dismissalLocal, dismissalPersisted,
                                       dismissalPending>>

CommitTrustedReview == /\ lock
                      /\ (~resolutionCommitted \/ SkipDecisionGuard)
                      /\ resolutionCommitted' = TRUE
                      /\ resolutionReceipt' = TRUE
                      /\ derivedChangeAdmitted' = TRUE
                      /\ committedTrusted' = TRUE
                      /\ commandCount' = commandCount + 1
                      /\ cloneReady' = FALSE
                      /\ lock' = FALSE
                      /\ actionError' = FALSE
                      /\ UNCHANGED <<sourceDecision, rowState, proofRetained,
                                     rawChangePresent, rawChangeAdmitted,
                                     dismissalLocal, dismissalPersisted,
                                     dismissalPending>>

RefreshProjection == /\ resolutionCommitted
                    /\ rowState # "resolved"
                    /\ rowState' = "resolved"
                    /\ dismissalLocal' = FALSE
                    /\ dismissalPersisted' = FALSE
                    /\ dismissalPending' = FALSE
                    /\ actionError' = FALSE
                    /\ UNCHANGED <<sourceDecision, resolutionCommitted, resolutionReceipt,
                                   derivedChangeAdmitted, proofRetained,
                                   rawChangePresent, rawChangeAdmitted,
                                   cloneReady, committedTrusted, commandCount,
                                   lock>>

Next == DismissRow \/ SaveDismissal \/ FailDismissalSave \/ RetryDismissalSave \/ DismissError
        \/ Reload \/ PrepareTrustedClone \/ StartReview
        \/ FailReviewPersistence \/ CommitTrustedReview \/ RefreshProjection

TypeOK == /\ sourceDecision = "quarantined"
          /\ resolutionCommitted \in BOOLEAN
          /\ resolutionReceipt \in BOOLEAN
          /\ derivedChangeAdmitted \in BOOLEAN
          /\ rowState \in {"pending", "dismissed", "resolved"}
          /\ proofRetained \in BOOLEAN
          /\ rawChangePresent \in BOOLEAN
          /\ rawChangeAdmitted \in BOOLEAN
          /\ cloneReady \in BOOLEAN
          /\ committedTrusted \in BOOLEAN
          /\ commandCount \in 0..2
          /\ lock \in BOOLEAN
          /\ actionError \in BOOLEAN
          /\ dismissalLocal \in BOOLEAN
          /\ dismissalPersisted \in BOOLEAN
          /\ dismissalPending \in BOOLEAN

ReviewResolutionIsDurable == rowState = "resolved" =>
  resolutionCommitted /\ resolutionReceipt /\ derivedChangeAdmitted
  /\ committedTrusted /\ commandCount = 1
DismissalPreservesProof == rowState = "dismissed" => proofRetained /\ rawChangePresent
SourceHistoryRetained == proofRetained /\ rawChangePresent
DismissalIsNotApproval == sourceDecision = "quarantined" /\ rawChangePresent /\ ~rawChangeAdmitted
AdmissionUsesTrustedClone == derivedChangeAdmitted => committedTrusted
AtMostOneAuthorizedCommand == commandCount <= 1
DismissalPersistenceConsistent == dismissalPersisted => ~dismissalPending

Spec == Init /\ [][Next]_vars
=============================================================================
