-------------------- MODULE KeeperOrphanResolution --------------------
EXTENDS Naturals, TLC

CONSTANTS HasIssuedGrant, GrantEpoch, TombstoneEpoch,
          ServiceHasActiveScope, ServiceHasPendingOperation,
          SkipLocalRevocation, IgnoreTombstoneEpoch, EraseHistoryOnDismiss

VARIABLES pairingPresent, statusVerified, tombstoneComplete, ownerRevoked,
          resolved, dismissed, historyPresent
vars == <<pairingPresent, statusVerified, tombstoneComplete, ownerRevoked,
          resolved, dismissed, historyPresent>>

Init ==
  /\ pairingPresent = TRUE
  /\ statusVerified = FALSE
  /\ tombstoneComplete = FALSE
  /\ ownerRevoked = FALSE
  /\ resolved = FALSE
  /\ dismissed = FALSE
  /\ historyPresent = TRUE

PruneExpiredPairing ==
  /\ pairingPresent
  /\ pairingPresent' = FALSE
  /\ UNCHANGED <<statusVerified, tombstoneComplete, ownerRevoked,
                  resolved, dismissed, historyPresent>>

VerifySignedStatus ==
  /\ ~statusVerified
  /\ statusVerified' = TRUE
  /\ tombstoneComplete' = ~ServiceHasActiveScope
       /\ ~ServiceHasPendingOperation
       /\ HasIssuedGrant
       /\ TombstoneEpoch >= GrantEpoch
  /\ UNCHANGED <<pairingPresent, ownerRevoked, resolved, dismissed, historyPresent>>

RevokeLocalOwnerGrant ==
  /\ HasIssuedGrant
  /\ statusVerified
  /\ tombstoneComplete
  /\ ~ownerRevoked
  /\ ownerRevoked' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  resolved, dismissed, historyPresent>>

ResolveOrphan ==
  /\ ~pairingPresent
  /\ statusVerified
  /\ ~ServiceHasActiveScope
  /\ ~ServiceHasPendingOperation
  /\ (IF HasIssuedGrant
        THEN (tombstoneComplete /\ ownerRevoked)
        ELSE ~tombstoneComplete)
  /\ resolved' = TRUE
  /\ dismissed' = FALSE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  ownerRevoked, historyPresent>>

UnsafeResolveWithoutLocalRevoke ==
  /\ SkipLocalRevocation
  /\ ~pairingPresent
  /\ statusVerified
  /\ tombstoneComplete
  /\ resolved' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  ownerRevoked, dismissed, historyPresent>>

UnsafeResolveStaleTombstone ==
  /\ IgnoreTombstoneEpoch
  /\ HasIssuedGrant
  /\ TombstoneEpoch < GrantEpoch
  /\ pairingPresent' = FALSE
  /\ statusVerified' = TRUE
  /\ resolved' = TRUE
  /\ UNCHANGED <<tombstoneComplete, ownerRevoked, dismissed, historyPresent>>

Dismiss ==
  /\ ~dismissed
  /\ dismissed' = TRUE
  /\ historyPresent' = IF EraseHistoryOnDismiss THEN FALSE ELSE historyPresent
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  ownerRevoked, resolved>>

Next == PruneExpiredPairing \/ VerifySignedStatus \/ RevokeLocalOwnerGrant
  \/ ResolveOrphan \/ UnsafeResolveWithoutLocalRevoke
  \/ UnsafeResolveStaleTombstone \/ Dismiss
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ pairingPresent \in BOOLEAN
  /\ statusVerified \in BOOLEAN
  /\ tombstoneComplete \in BOOLEAN
  /\ ownerRevoked \in BOOLEAN
  /\ resolved \in BOOLEAN
  /\ dismissed \in BOOLEAN
  /\ historyPresent \in BOOLEAN

ResolvedHasServiceAndOwnerEvidence ==
  resolved => (statusVerified /\ (~HasIssuedGrant \/ (tombstoneComplete /\ ownerRevoked)))

DismissPreservesHistory == dismissed => historyPresent

=============================================================================
