-------------------------- MODULE DurableTransport --------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Hashes, AckAfterCommit
ASSUME /\ Hashes # {} /\ "none" \notin Hashes /\ AckAfterCommit \in BOOLEAN
VARIABLES connected, packet, phase, durable, proofs, acknowledged, published
vars == <<connected, packet, phase, durable, proofs, acknowledged, published>>

Init == /\ connected = FALSE /\ packet = "none" /\ phase = "idle"
        /\ durable = {} /\ proofs = {} /\ acknowledged = {} /\ published = {}

Reconnect == /\ ~connected /\ connected' = TRUE
              /\ UNCHANGED <<packet, phase, durable, proofs, acknowledged, published>>

Send(h) == /\ connected /\ phase = "idle" /\ h \notin acknowledged
           /\ packet' = h /\ phase' = "transit"
           /\ UNCHANGED <<connected, durable, proofs, acknowledged, published>>

Receive(h) == /\ connected /\ phase = "transit" /\ packet = h
              /\ phase' = "staged"
              /\ UNCHANGED <<connected, packet, durable, proofs, acknowledged, published>>

Commit(h) == /\ connected /\ phase = "staged" /\ packet = h
             /\ durable' = durable \cup {h} /\ proofs' = proofs \cup {h}
             /\ phase' = "ack"
             /\ UNCHANGED <<connected, packet, acknowledged, published>>

Ack(h) == /\ connected /\ packet = h
          /\ phase = "ack" \/ (~AckAfterCommit /\ phase = "staged")
          /\ acknowledged' = acknowledged \cup {h}
          /\ packet' = "none" /\ phase' = "idle"
          /\ UNCHANGED <<connected, durable, proofs, published>>

\* Includes QUIC publish failure, dropped ACK, and process restart. Durable
\* coverage survives; volatile packet and connection do not. No timeout bound.
DisconnectOrCrash == /\ connected
                     /\ connected' = FALSE /\ packet' = "none" /\ phase' = "idle"
                     /\ UNCHANGED <<durable, proofs, acknowledged, published>>

Publish(h) == /\ h \in durable /\ h \notin published
              /\ published' = published \cup {h}
              /\ UNCHANGED <<connected, packet, phase, durable, proofs, acknowledged>>

Next == Reconnect \/ DisconnectOrCrash \/
        (\E h \in Hashes: Send(h) \/ Receive(h) \/ Commit(h) \/ Ack(h) \/ Publish(h))
Spec == Init /\ [][Next]_vars
OfflineSpec == Spec /\ []~connected
ReconnectOnlySpec == Spec /\ WF_vars(Reconnect)
\* Each unacknowledged hash must repeatedly get a usable send/delivery/commit/
\* ACK opportunity. WF(Reconnect) alone cannot provide this network guarantee.
FairSpec == Spec /\ WF_vars(Reconnect) /\
  (\A h \in Hashes: SF_vars(Send(h)) /\ SF_vars(Receive(h)) /\
                    SF_vars(Commit(h)) /\ SF_vars(Ack(h)) /\ WF_vars(Publish(h)))

TypeOK == /\ connected \in BOOLEAN /\ packet \in Hashes \cup {"none"}
          /\ phase \in {"idle", "transit", "staged", "ack"}
          /\ durable \subseteq Hashes /\ proofs \subseteq Hashes
          /\ acknowledged \subseteq Hashes /\ published \subseteq Hashes
AckDurable == acknowledged \subseteq durable
ProofCoverage == durable \subseteq proofs
PublicationDurable == published \subseteq durable
ConnectionImpliesCoverage == connected => acknowledged = Hashes
EventuallyDelivered == <> (acknowledged = Hashes /\ published = Hashes)
=============================================================================
