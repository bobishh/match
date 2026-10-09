--------------------- MODULE ReviewedWorkspaceBootstrap -------------------
EXTENDS FiniteSets, TLC

CONSTANTS RejectQuarantinedHistory, SourceChange, AuthorizedClone
ASSUME /\ RejectQuarantinedHistory \in BOOLEAN
       /\ SourceChange # AuthorizedClone

VARIABLES rawHistory, admittedProjection, resolutionCommitted,
          bootstrapInput, bootstrapReady, bootstrapRejected
vars == <<rawHistory, admittedProjection, resolutionCommitted,
          bootstrapInput, bootstrapReady, bootstrapRejected>>

Init == /\ rawHistory = {SourceChange, AuthorizedClone}
        /\ admittedProjection = {AuthorizedClone}
        /\ resolutionCommitted = TRUE
        /\ bootstrapInput = {}
        /\ bootstrapReady = FALSE
        /\ bootstrapRejected = FALSE

BootstrapAdmittedProjection == /\ resolutionCommitted
                              /\ ~RejectQuarantinedHistory
                              /\ ~bootstrapReady
                              /\ ~bootstrapRejected
                              /\ bootstrapInput' = rawHistory
                              /\ bootstrapRejected' = FALSE
                              /\ bootstrapReady' = TRUE
                              /\ UNCHANGED <<rawHistory, admittedProjection,
                                             resolutionCommitted>>

BootstrapRejectsQuarantine == /\ resolutionCommitted
                              /\ RejectQuarantinedHistory
                              /\ ~bootstrapReady
                              /\ ~bootstrapRejected
                              /\ bootstrapInput' = rawHistory
                              /\ bootstrapRejected' = TRUE
                              /\ bootstrapReady' = FALSE
                              /\ UNCHANGED <<rawHistory, admittedProjection,
                                             resolutionCommitted>>

Next == BootstrapAdmittedProjection \/ BootstrapRejectsQuarantine
Spec == Init /\ [][Next]_vars

TypeOK == /\ rawHistory \subseteq {SourceChange, AuthorizedClone}
          /\ admittedProjection \subseteq {SourceChange, AuthorizedClone}
          /\ resolutionCommitted \in BOOLEAN
          /\ bootstrapInput \subseteq {SourceChange, AuthorizedClone}
          /\ bootstrapReady \in BOOLEAN
          /\ bootstrapRejected \in BOOLEAN

SourceHistoryRetained == SourceChange \in rawHistory
SourceNeverAdmitted == SourceChange \notin admittedProjection
ResolvedCloneIsAdmitted == resolutionCommitted => AuthorizedClone \in admittedProjection
BootstrapClassifiesRawHistory == bootstrapReady => bootstrapInput = rawHistory
BootstrapSeparatesProjection == bootstrapReady => SourceChange \notin admittedProjection
ResolvedWorkspaceCanBootstrap == ~bootstrapRejected

=============================================================================
