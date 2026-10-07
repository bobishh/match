---------------- MODULE IdentityCatalog ----------------
EXTENDS FiniteSets, TLC

CONSTANTS OldIdentity, NewIdentity, OldBoard, NewBoard, InvitedBoard, SharedBoard,
          Identities, Workspaces

ASSUME Identities = {OldIdentity, NewIdentity}
ASSUME Workspaces = {OldBoard, NewBoard, InvitedBoard, SharedBoard}

Owner(w) == CASE w = OldBoard -> OldIdentity
            [] w = NewBoard -> NewIdentity
            [] OTHER -> OldIdentity
Entitled(i) == CASE i = OldIdentity -> {OldBoard, SharedBoard}
               [] OTHER -> {NewBoard, InvitedBoard, SharedBoard}

VARIABLES activeIdentity, localDocuments, visibleCatalog
vars == <<activeIdentity, localDocuments, visibleCatalog>>

Init ==
  /\ activeIdentity = OldIdentity
  /\ localDocuments = Workspaces
  /\ visibleCatalog = Entitled(OldIdentity)

AdoptNewIdentity ==
  /\ activeIdentity = OldIdentity
  /\ activeIdentity' = NewIdentity
  /\ visibleCatalog' = localDocuments \cap Entitled(NewIdentity)
  /\ UNCHANGED localDocuments

LocalRefresh ==
  /\ visibleCatalog' = localDocuments \cap Entitled(activeIdentity)
  /\ UNCHANGED <<activeIdentity, localDocuments>>

OwnerOffline == UNCHANGED vars

Next == AdoptNewIdentity \/ LocalRefresh \/ OwnerOffline
Spec == Init /\ [][Next]_vars

CatalogIsEntitled == visibleCatalog \subseteq Entitled(activeIdentity)
DocumentsArePreserved == localDocuments = Workspaces
LocalOwnerAuthority == {w \in Workspaces : Owner(w) = activeIdentity}
RoleOf(w) == IF Owner(w) = activeIdentity THEN "owner"
             ELSE IF w \in Entitled(activeIdentity) THEN "member" ELSE "none"
NoOwnershipEscalation ==
  \A w \in Workspaces : Owner(w) # activeIdentity => RoleOf(w) # "owner"
OwnerAuthorityOnly ==
  \A w \in Workspaces : (w \in LocalOwnerAuthority) <=> (Owner(w) = activeIdentity)
InvitedAndSharedRemainVisible ==
  activeIdentity = NewIdentity =>
    {w \in {InvitedBoard, SharedBoard} : w \in Entitled(NewIdentity)} \subseteq visibleCatalog
OldOnlyBoardHidden == activeIdentity = NewIdentity => OldBoard \notin visibleCatalog

=============================================================
