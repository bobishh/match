---------------- MODULE WorkerLifecycle ----------------
EXTENDS FiniteSets, Naturals, TLC

CONSTANTS Generations, Jobs, BadStaleFailureKinds

ASSUME Generations = {0, 1, 2}
ASSUME Jobs = {"J1", "J2"}
FailureKinds == {"fatal", "queued-timeout"}
ASSUME BadStaleFailureKinds \subseteq FailureKinds

WorkerStates == {"absent", "starting", "ready", "failed"}
JobStates == {"idle", "queued", "sent", "failed"}

VARIABLES currentGeneration, workerState, readyGenerations,
          jobState, sentGeneration, staleFailureAffected
vars == <<currentGeneration, workerState, readyGenerations,
          jobState, sentGeneration, staleFailureAffected>>

Init ==
  /\ currentGeneration = 0
  /\ workerState = [g \in Generations |-> "absent"]
  /\ readyGenerations = {}
  /\ jobState = [j \in Jobs |-> "idle"]
  /\ sentGeneration = [j \in Jobs |-> 0]
  /\ staleFailureAffected = {}

StartWorker ==
  /\ currentGeneration < 2
  /\ workerState[currentGeneration] \in {"absent", "failed"}
  /\ currentGeneration' = currentGeneration + 1
  /\ workerState' = [workerState EXCEPT ![currentGeneration + 1] = "starting"]
  /\ UNCHANGED <<readyGenerations, jobState, sentGeneration, staleFailureAffected>>

WorkerReady(g) ==
  /\ g = currentGeneration
  /\ workerState[g] = "starting"
  /\ workerState' = [workerState EXCEPT ![g] = "ready"]
  /\ readyGenerations' = readyGenerations \cup {g}
  /\ UNCHANGED <<currentGeneration, jobState, sentGeneration, staleFailureAffected>>

Submit(j) ==
  /\ jobState[j] = "idle"
  /\ jobState' = [jobState EXCEPT ![j] = "queued"]
  /\ UNCHANGED <<currentGeneration, workerState, readyGenerations,
                 sentGeneration, staleFailureAffected>>

Transfer(j) ==
  /\ jobState[j] = "queued"
  /\ workerState[currentGeneration] = "ready"
  /\ jobState' = [jobState EXCEPT ![j] = "sent"]
  /\ sentGeneration' = [sentGeneration EXCEPT ![j] = currentGeneration]
  /\ UNCHANGED <<currentGeneration, workerState, readyGenerations, staleFailureAffected>>

CurrentFailure(g) ==
  /\ g = currentGeneration
  /\ workerState[g] \in {"starting", "ready"}
  /\ workerState' = [workerState EXCEPT ![g] = "failed"]
  /\ jobState' = [j \in Jobs |-> IF jobState[j] = "queued" THEN "failed" ELSE jobState[j]]
  /\ UNCHANGED <<currentGeneration, readyGenerations, sentGeneration, staleFailureAffected>>

StaleFailure(g, kind) ==
  /\ g < currentGeneration
  /\ workerState[g] = "failed"
  /\ kind \in FailureKinds
  /\ IF kind \in BadStaleFailureKinds
       THEN /\ workerState' = [workerState EXCEPT ![currentGeneration] = "failed"]
            /\ jobState' = [j \in Jobs |-> IF jobState[j] = "queued" THEN "failed" ELSE jobState[j]]
            /\ staleFailureAffected' = staleFailureAffected \cup {kind}
       ELSE /\ UNCHANGED <<workerState, jobState, staleFailureAffected>>
  /\ UNCHANGED <<currentGeneration, readyGenerations, sentGeneration>>

Next ==
  \/ StartWorker
  \/ \E g \in Generations : WorkerReady(g) \/ CurrentFailure(g)
  \/ \E g \in Generations : \E kind \in FailureKinds : StaleFailure(g, kind)
  \/ \E j \in Jobs : Submit(j) \/ Transfer(j)

Spec == Init /\ [][Next]_vars

TransferAfterReady ==
  \A j \in Jobs : jobState[j] = "sent" => sentGeneration[j] \in readyGenerations

StaleFatalIsolated == "fatal" \notin staleFailureAffected
QueuedTimeoutIsolated == "queued-timeout" \notin staleFailureAffected

=============================================================
