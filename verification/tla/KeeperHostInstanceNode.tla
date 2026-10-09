-------------------- MODULE KeeperHostInstanceNode --------------------
EXTENDS Naturals, TLC

CONSTANTS LeaseKey, LegacyKey, InitialHostKey, ReloadHostKey
Keys == {LeaseKey, LegacyKey}

VARIABLES hostRunning, hostEndpointKey, adoptedEndpointKey, meshAdopted, reloaded
vars == <<hostRunning, hostEndpointKey, adoptedEndpointKey, meshAdopted, reloaded>>

Init ==
  /\ hostRunning = FALSE
  /\ hostEndpointKey = "none"
  /\ adoptedEndpointKey = "none"
  /\ meshAdopted = FALSE
  /\ reloaded = FALSE

StartInvitationHost ==
  /\ ~hostRunning
  /\ hostRunning' = TRUE
  /\ hostEndpointKey' = InitialHostKey
  /\ UNCHANGED <<adoptedEndpointKey, meshAdopted, reloaded>>

AdoptWorkspaceIntoDurableMesh ==
  /\ hostRunning
  /\ ~meshAdopted
  /\ meshAdopted' = TRUE
  /\ adoptedEndpointKey' = hostEndpointKey
  /\ UNCHANGED <<hostRunning, hostEndpointKey, reloaded>>

ReloadInvitationHost ==
  /\ hostRunning
  /\ meshAdopted
  /\ ~reloaded
  /\ hostEndpointKey' = ReloadHostKey
  /\ reloaded' = TRUE
  /\ UNCHANGED <<hostRunning, adoptedEndpointKey, meshAdopted>>

Next == StartInvitationHost \/ AdoptWorkspaceIntoDurableMesh \/ ReloadInvitationHost
  \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ hostRunning \in BOOLEAN
  /\ hostEndpointKey \in Keys \cup {"none"}
  /\ adoptedEndpointKey \in Keys \cup {"none"}
  /\ meshAdopted \in BOOLEAN
  /\ reloaded \in BOOLEAN

AdoptedHostUsesLeasedInstanceKey == meshAdopted /\ reloaded => adoptedEndpointKey = LeaseKey
ReloadKeepsAdoptedRoute == reloaded => hostEndpointKey = adoptedEndpointKey

=============================================================================
