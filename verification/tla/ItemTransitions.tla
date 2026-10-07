------------------------- MODULE ItemTransitions -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Columns, ArchiveColumn, Rejected, InitialColumn
ASSUME /\ Columns = {ArchiveColumn, Rejected, InitialColumn}
       /\ ArchiveColumn \in Columns
       /\ Rejected \in Columns
       /\ InitialColumn \in Columns
       /\ ArchiveColumn # Rejected
       /\ ArchiveColumn # InitialColumn
       /\ Rejected # InitialColumn

VARIABLES placement, workflow, lifecycle, collapsed, clock, published, failed, archiveColumnId
vars == <<placement, workflow, lifecycle, collapsed, clock, published, failed, archiveColumnId>>

Init == /\ placement = InitialColumn
        /\ workflow = [column |-> InitialColumn, changedAt |-> 0]
        /\ lifecycle = [state |-> "active", changedAt |-> 0]
        /\ collapsed = [c \in Columns |-> FALSE]
        /\ clock = 0
        /\ published = FALSE
        /\ failed = FALSE
        /\ archiveColumnId = ArchiveColumn

Move(c) == /\ c \in Columns \ {ArchiveColumn}
          /\ c # placement
          /\ clock < 3
          /\ placement' = c
          /\ workflow' = [column |-> c, changedAt |-> clock + 1]
          /\ clock' = clock + 1
          /\ UNCHANGED <<lifecycle, collapsed, published, failed, archiveColumnId>>

Archive == /\ lifecycle.state = "active"
           /\ clock < 3
           /\ lifecycle' = [state |-> "archived", changedAt |-> clock + 1]
           /\ clock' = clock + 1
           /\ UNCHANGED <<placement, workflow, collapsed, published, failed, archiveColumnId>>

Restore == /\ lifecycle.state = "archived"
           /\ clock < 3
           /\ lifecycle' = [state |-> "active", changedAt |-> clock + 1]
           /\ clock' = clock + 1
           /\ UNCHANGED <<placement, workflow, collapsed, published, failed, archiveColumnId>>

ToggleCollapse(c) == /\ c \in Columns
                    /\ collapsed' = [collapsed EXCEPT ![c] = ~@]
                    /\ UNCHANGED <<placement, workflow, lifecycle, clock, published, failed, archiveColumnId>>

Publish == /\ ~failed
          /\ published' = TRUE
          /\ UNCHANGED <<placement, workflow, lifecycle, collapsed, clock, failed, archiveColumnId>>

FailPublish == /\ ~published
              /\ failed' = TRUE
              /\ UNCHANGED <<placement, workflow, lifecycle, collapsed, clock, published, archiveColumnId>>

EnsureArchiveColumn == /\ archiveColumnId \in {ArchiveColumn, "none"}
                      /\ archiveColumnId' = ArchiveColumn
                      /\ UNCHANGED <<placement, workflow, lifecycle, collapsed, clock, published, failed>>

Next == \/ \E c \in Columns: ToggleCollapse(c)
        \/ \E c \in Columns: Move(c)
        \/ Archive
        \/ Restore
        \/ Publish
        \/ FailPublish
        \/ EnsureArchiveColumn

Spec == Init /\ [][Next]_vars

TypeOK == /\ placement \in Columns
          /\ workflow \in [column: Columns, changedAt: Nat]
          /\ lifecycle \in [state: {"active", "archived"}, changedAt: Nat]
          /\ collapsed \in [Columns -> BOOLEAN]
          /\ clock \in 0..3
          /\ published \in BOOLEAN
          /\ failed \in BOOLEAN
          /\ archiveColumnId \in {ArchiveColumn, "none"}

ArchiveDestinationUnique == /\ ArchiveColumn \in Columns
                            /\ archiveColumnId \in {ArchiveColumn, "none"}
WorkflowMatchesPlacement == workflow.column = placement
WorkflowTimestampMatchesClock == workflow.changedAt <= clock
LifecycleTimestampMatchesClock == lifecycle.changedAt <= clock
CollapseIndependent == collapsed \in [Columns -> BOOLEAN]
FailurePublishesNothing == failed => ~published
WorkflowRecordPaired == workflow.changedAt \in 0..clock
ArchiveRestorePreservesWorkflow == [][(Archive \/ Restore) => workflow' = workflow]_vars
=============================================================================
