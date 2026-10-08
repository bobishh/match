-------------------- MODULE KeeperOrphanResolution --------------------
EXTENDS Naturals, TLC

CONSTANTS HasIssuedGrant, GrantEpoch, TombstoneEpoch,
          ServiceHasActiveScope, ServiceHasPendingOperation,
          SkipLocalRevocation, IgnoreTombstoneEpoch, EraseHistoryOnDismiss,
          IgnoreCleanupGate, GlobalOutboxGate, IgnoreFlowGeneration, ResurrectOnReload

VARIABLES pairingPresent, statusVerified, tombstoneComplete,
          localKeeperGrantRevoked, resolved, dismissed, outboxPresent,
          requestVisible, discoveryAvailable, discoveryAttempted, discoveryBlocked,
          flowEpoch, requestEpoch, preflightPending, sameTargetRequestStarted,
          otherTargetRequestStarted

vars == <<pairingPresent, statusVerified, tombstoneComplete,
          localKeeperGrantRevoked, resolved, dismissed, outboxPresent,
          requestVisible, discoveryAvailable, discoveryAttempted, discoveryBlocked,
          flowEpoch, requestEpoch, preflightPending, sameTargetRequestStarted,
          otherTargetRequestStarted>>

Init ==
  /\ pairingPresent = TRUE
  /\ statusVerified = FALSE
  /\ tombstoneComplete = FALSE
  /\ localKeeperGrantRevoked = FALSE
  /\ resolved = FALSE
  /\ dismissed = FALSE
  /\ outboxPresent = TRUE
  /\ requestVisible = TRUE
  /\ discoveryAvailable = FALSE
  /\ discoveryAttempted = FALSE
  /\ discoveryBlocked = FALSE
  /\ flowEpoch = 0
  /\ requestEpoch = 0
  /\ preflightPending = FALSE
  /\ sameTargetRequestStarted = FALSE
  /\ otherTargetRequestStarted = FALSE

PruneExpiredPairing ==
  /\ pairingPresent
  /\ pairingPresent' = FALSE
  /\ UNCHANGED <<statusVerified, tombstoneComplete, localKeeperGrantRevoked,
                  resolved, dismissed, outboxPresent, requestVisible,
                  discoveryAvailable, discoveryAttempted, discoveryBlocked,
                  flowEpoch, requestEpoch, preflightPending, sameTargetRequestStarted,
                  otherTargetRequestStarted>>

VerifySignedStatus ==
  /\ ~statusVerified
  /\ statusVerified' = TRUE
  /\ tombstoneComplete' = ~ServiceHasActiveScope
       /\ ~ServiceHasPendingOperation
       /\ HasIssuedGrant
       /\ TombstoneEpoch >= GrantEpoch
  /\ UNCHANGED <<pairingPresent, localKeeperGrantRevoked, resolved, dismissed,
                  outboxPresent, requestVisible, discoveryAvailable, discoveryAttempted,
                  discoveryBlocked, flowEpoch, requestEpoch, preflightPending,
                  sameTargetRequestStarted, otherTargetRequestStarted>>

RevokeLocalKeeperGrant ==
  /\ HasIssuedGrant
  /\ statusVerified
  /\ tombstoneComplete
  /\ ~localKeeperGrantRevoked
  /\ localKeeperGrantRevoked' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete, resolved,
                  dismissed, outboxPresent, requestVisible, discoveryAvailable,
                  discoveryAttempted, discoveryBlocked, flowEpoch, requestEpoch,
                  preflightPending, sameTargetRequestStarted, otherTargetRequestStarted>>

ResolveOrphan ==
  /\ ~pairingPresent
  /\ ~resolved
  /\ statusVerified
  /\ ~ServiceHasActiveScope
  /\ ~ServiceHasPendingOperation
  /\ (IF HasIssuedGrant
        THEN (tombstoneComplete /\ localKeeperGrantRevoked)
        ELSE ~tombstoneComplete)
  /\ resolved' = TRUE
  /\ outboxPresent' = FALSE
  /\ requestVisible' = FALSE
  /\ dismissed' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, discoveryAvailable, discoveryAttempted,
                  discoveryBlocked, flowEpoch, requestEpoch, preflightPending,
                  sameTargetRequestStarted, otherTargetRequestStarted>>

UnsafeResolveWithoutLocalRevoke ==
  /\ SkipLocalRevocation
  /\ ~pairingPresent
  /\ statusVerified
  /\ tombstoneComplete
  /\ resolved' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, dismissed, outboxPresent, requestVisible,
                  discoveryAvailable, discoveryAttempted, discoveryBlocked,
                  flowEpoch, requestEpoch, preflightPending, sameTargetRequestStarted,
                  otherTargetRequestStarted>>

UnsafeResolveStaleTombstone ==
  /\ IgnoreTombstoneEpoch
  /\ HasIssuedGrant
  /\ TombstoneEpoch < GrantEpoch
  /\ pairingPresent' = FALSE
  /\ statusVerified' = TRUE
  /\ resolved' = TRUE
  /\ UNCHANGED <<tombstoneComplete, localKeeperGrantRevoked, dismissed,
                  outboxPresent, requestVisible, discoveryAvailable,
                  discoveryAttempted, discoveryBlocked, flowEpoch, requestEpoch,
                  preflightPending, sameTargetRequestStarted, otherTargetRequestStarted>>

Dismiss ==
  /\ requestVisible
  /\ dismissed' = TRUE
  /\ requestVisible' = FALSE
  /\ flowEpoch' = flowEpoch + 1
  /\ discoveryAvailable' = FALSE
  /\ discoveryAttempted' = FALSE
  /\ outboxPresent' = IF EraseHistoryOnDismiss THEN FALSE ELSE outboxPresent
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, discoveryBlocked,
                  requestEpoch, preflightPending, sameTargetRequestStarted,
                  otherTargetRequestStarted>>

Reload ==
  /\ dismissed
  /\ requestVisible' = ResurrectOnReload /\ outboxPresent
  /\ discoveryAvailable' = FALSE
  /\ discoveryAttempted' = FALSE
  /\ discoveryBlocked' = FALSE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, dismissed, outboxPresent,
                  flowEpoch, requestEpoch, preflightPending, sameTargetRequestStarted,
                  otherTargetRequestStarted>>

OpenDiscovery ==
  /\ ~discoveryAttempted
  /\ discoveryAttempted' = TRUE
  /\ discoveryAvailable' = ~ (GlobalOutboxGate /\ outboxPresent)
  /\ discoveryBlocked' = GlobalOutboxGate /\ outboxPresent
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, dismissed, outboxPresent,
                  requestVisible, flowEpoch, requestEpoch, preflightPending,
                  sameTargetRequestStarted, otherTargetRequestStarted>>

StartSameTargetPreflight ==
  /\ discoveryAvailable
  /\ ~discoveryBlocked
  /\ ~sameTargetRequestStarted
  /\ statusVerified
  /\ ~ServiceHasPendingOperation
  /\ (IF IgnoreCleanupGate THEN TRUE ELSE (~outboxPresent \/ resolved))
  /\ preflightPending' = TRUE
  /\ requestEpoch' = flowEpoch
  /\ requestVisible' = TRUE
  /\ dismissed' = FALSE
  /\ sameTargetRequestStarted' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, outboxPresent,
                  discoveryAvailable, discoveryAttempted, discoveryBlocked, flowEpoch,
                  otherTargetRequestStarted>>

AbandonPreflight ==
  /\ preflightPending
  /\ requestEpoch = flowEpoch
  /\ ~dismissed
  /\ dismissed' = TRUE
  /\ requestVisible' = FALSE
  /\ flowEpoch' = flowEpoch + 1
  /\ discoveryAvailable' = FALSE
  /\ discoveryAttempted' = FALSE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, outboxPresent, discoveryBlocked,
                  requestEpoch, preflightPending, sameTargetRequestStarted,
                  otherTargetRequestStarted>>

CompletePreflight ==
  /\ preflightPending
  /\ preflightPending' = FALSE
  /\ requestVisible' = IF IgnoreFlowGeneration \/ requestEpoch = flowEpoch THEN TRUE ELSE requestVisible
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, dismissed, outboxPresent,
                  discoveryAvailable, discoveryAttempted, discoveryBlocked,
                  flowEpoch, requestEpoch, sameTargetRequestStarted,
                  otherTargetRequestStarted>>

StartOtherTargetRequest ==
  /\ discoveryAvailable
  /\ ~otherTargetRequestStarted
  /\ otherTargetRequestStarted' = TRUE
  /\ UNCHANGED <<pairingPresent, statusVerified, tombstoneComplete,
                  localKeeperGrantRevoked, resolved, dismissed, outboxPresent,
                  requestVisible, discoveryAvailable, discoveryAttempted,
                  discoveryBlocked, flowEpoch, requestEpoch, preflightPending,
                  sameTargetRequestStarted>>

Next == PruneExpiredPairing \/ VerifySignedStatus \/ RevokeLocalKeeperGrant
  \/ ResolveOrphan \/ StartOtherTargetRequest \/ Dismiss \/ Reload \/ OpenDiscovery
  \/ StartSameTargetPreflight \/ AbandonPreflight \/ CompletePreflight \/ UnsafeResolveWithoutLocalRevoke
  \/ UnsafeResolveStaleTombstone
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ pairingPresent \in BOOLEAN
  /\ statusVerified \in BOOLEAN
  /\ tombstoneComplete \in BOOLEAN
  /\ localKeeperGrantRevoked \in BOOLEAN
  /\ resolved \in BOOLEAN
  /\ dismissed \in BOOLEAN
  /\ outboxPresent \in BOOLEAN
  /\ requestVisible \in BOOLEAN
  /\ discoveryAvailable \in BOOLEAN
  /\ discoveryAttempted \in BOOLEAN
  /\ discoveryBlocked \in BOOLEAN
  /\ flowEpoch \in Nat
  /\ requestEpoch \in Nat
  /\ preflightPending \in BOOLEAN
  /\ sameTargetRequestStarted \in BOOLEAN
  /\ otherTargetRequestStarted \in BOOLEAN

ResolvedHasServiceAndLocalGrantEvidence ==
  resolved => (statusVerified /\ (~HasIssuedGrant \/ (tombstoneComplete /\ localKeeperGrantRevoked)))

DismissPreservesOutbox == dismissed => outboxPresent \/ resolved
DismissHidesRequest == dismissed => ~requestVisible
OutboxDoesNotBlockDiscovery == discoveryAttempted => (discoveryAvailable /\ ~discoveryBlocked)
SameTargetStartNeedsCleanupResolution == sameTargetRequestStarted =>
  (statusVerified /\ ~ServiceHasPendingOperation /\ (~outboxPresent \/ resolved))
StalePreflightCannotReopenDismissedRequest == dismissed /\ ~preflightPending => ~requestVisible

=============================================================================
