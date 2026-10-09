-------------------- MODULE RevocationGeneration --------------------
EXTENDS Naturals, TLC

CONSTANT PersonOnlyIdempotency

VARIABLES grantEpoch, revokedThrough, removalComplete
vars == <<grantEpoch, revokedThrough, removalComplete>>

Init ==
  /\ grantEpoch = 2
  /\ revokedThrough = 2
  /\ removalComplete = TRUE

Regrant ==
  /\ grantEpoch = 2
  /\ revokedThrough = 2
  /\ grantEpoch' = 3
  /\ removalComplete' = FALSE
  /\ UNCHANGED revokedThrough

RevokeCurrentGrant ==
  /\ grantEpoch = 3
  /\ revokedThrough < grantEpoch
  /\ ~removalComplete
  /\ revokedThrough' = IF PersonOnlyIdempotency
                         THEN revokedThrough
                         ELSE grantEpoch + 1
  /\ removalComplete' = TRUE
  /\ UNCHANGED grantEpoch

Next == Regrant \/ RevokeCurrentGrant \/ UNCHANGED vars

TypeOK ==
  /\ grantEpoch \in {2, 3}
  /\ revokedThrough \in {2, 4}
  /\ removalComplete \in BOOLEAN

CompletedRevokeCoversCurrentGrant ==
  removalComplete => revokedThrough >= grantEpoch

Spec == Init /\ [][Next]_vars

=====================================================================
