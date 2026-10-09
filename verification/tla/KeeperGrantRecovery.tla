-------------------- MODULE KeeperGrantRecovery --------------------
EXTENDS Naturals, TLC

CONSTANTS LocalNextEpoch, ServiceTombstoneEpoch, StatusSignatureValid

VARIABLES observedFloor, floorVerified, grantEpoch, requestPhase, ownerRole
vars == <<observedFloor, floorVerified, grantEpoch, requestPhase, ownerRole>>

Init ==
  /\ observedFloor = 0
  /\ floorVerified = FALSE
  /\ grantEpoch = 5
  /\ requestPhase = "old-approved"
  /\ ownerRole = "owner"

ReadSignedFloor ==
  /\ StatusSignatureValid
  /\ ~floorVerified
  /\ observedFloor' = ServiceTombstoneEpoch
  /\ floorVerified' = TRUE
  /\ UNCHANGED <<grantEpoch, requestPhase, ownerRole>>

RejectStaleApproval ==
  /\ requestPhase = "old-approved"
  /\ grantEpoch <= ServiceTombstoneEpoch
  /\ requestPhase' = "restored"
  /\ UNCHANGED <<observedFloor, floorVerified, grantEpoch, ownerRole>>

IssueFreshGrant ==
  /\ requestPhase = "restored"
  /\ floorVerified
  /\ grantEpoch' = IF LocalNextEpoch > observedFloor + 1
                     THEN LocalNextEpoch
                     ELSE observedFloor + 1
  /\ grantEpoch' > observedFloor
  /\ requestPhase' = "fresh-offered"
  /\ UNCHANGED <<observedFloor, floorVerified, ownerRole>>

ApproveFreshRequest ==
  /\ requestPhase = "fresh-offered"
  /\ requestPhase' = "fresh-approved"
  /\ UNCHANGED <<observedFloor, floorVerified, grantEpoch, ownerRole>>

ActivateFreshRequest ==
  /\ requestPhase = "fresh-approved"
  /\ grantEpoch > ServiceTombstoneEpoch
  /\ requestPhase' = "active"
  /\ UNCHANGED <<observedFloor, floorVerified, grantEpoch, ownerRole>>

Next == ReadSignedFloor \/ RejectStaleApproval \/ IssueFreshGrant \/ ApproveFreshRequest \/ ActivateFreshRequest \/ UNCHANGED vars

TypeOK ==
  /\ observedFloor \in {0, ServiceTombstoneEpoch}
  /\ floorVerified \in BOOLEAN
  /\ grantEpoch \in {0, 5, IF LocalNextEpoch > ServiceTombstoneEpoch + 1
                            THEN LocalNextEpoch
                            ELSE ServiceTombstoneEpoch + 1}
  /\ requestPhase \in {"old-approved", "restored", "fresh-offered", "fresh-approved", "active"}
  /\ ownerRole = "owner"

FreshActivationClearsFence == requestPhase = "active" => grantEpoch > ServiceTombstoneEpoch
IssuedGrantUsesVerifiedFloor == grantEpoch > 5 => floorVerified
OwnerIdentityPreserved == ownerRole = "owner"

Spec == Init /\ [][Next]_vars

=====================================================================
