---------------------------- MODULE ProofTransfer ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS RecordCount, CountLimit, ByteLimit, RecordBytes, Paged
ASSUME /\ RecordCount > 0 /\ CountLimit > 0 /\ RecordBytes > 0
       /\ ByteLimit >= RecordBytes /\ Paged \in BOOLEAN
Records == 1..RecordCount
Authority == {"genesis", "current-owner", "owner-transition"}
PageSize == IF CountLimit < (ByteLimit \div RecordBytes)
            THEN CountLimit ELSE (ByteLimit \div RecordBytes)
Fits(rs) == Cardinality(rs) <= CountLimit /\ Cardinality(rs) * RecordBytes <= ByteLimit

VARIABLES durable, acknowledged, packet, phase, published, rejected, authority
vars == <<durable, acknowledged, packet, phase, published, rejected, authority>>
Init == /\ durable = {} /\ acknowledged = {} /\ packet = {}
        /\ phase = "idle" /\ published = FALSE /\ rejected = FALSE
        /\ authority = Authority

Send == /\ phase = "idle" /\ acknowledged # Records /\ ~rejected
         /\ packet' = (IF Paged
              THEN (Cardinality(acknowledged)+1)..
                   (IF Cardinality(acknowledged)+PageSize < RecordCount
                    THEN Cardinality(acknowledged)+PageSize ELSE RecordCount)
              ELSE Records)
         /\ phase' = "receive"
         /\ UNCHANGED <<durable, acknowledged, published, rejected, authority>>

Persist == /\ phase = "receive" /\ Fits(packet)
            /\ durable' = durable \cup packet
            /\ phase' = "ack"
            /\ UNCHANGED <<acknowledged, packet, published, rejected, authority>>

Reject == /\ phase = "receive" /\ ~Fits(packet)
           /\ rejected' = TRUE /\ packet' = {} /\ phase' = "idle"
           /\ UNCHANGED <<durable, acknowledged, published, authority>>

Ack == /\ phase = "ack"
        /\ acknowledged' = acknowledged \cup packet
        /\ phase' = "idle" /\ packet' = {}
        /\ UNCHANGED <<durable, published, rejected, authority>>

DropOrRestart == /\ phase \in {"receive", "ack"}
                /\ phase' = "idle" /\ packet' = {}
                /\ UNCHANGED <<durable, acknowledged, published, rejected, authority>>

Publish == /\ durable = Records /\ ~published /\ published' = TRUE
           /\ UNCHANGED <<durable, acknowledged, packet, phase, rejected, authority>>

Next == Send \/ Persist \/ Reject \/ Ack \/ DropOrRestart \/ Publish
Spec == Init /\ [][Next]_vars
\* Strong fairness is necessary: loss may disable Persist/Ack infinitely often.
FairSpec == Spec /\ WF_vars(Send) /\ SF_vars(Persist) /\ SF_vars(Ack) /\ WF_vars(Publish)

TypeOK == /\ durable \subseteq Records /\ acknowledged \subseteq Records
          /\ packet \subseteq Records /\ phase \in {"idle", "receive", "ack"}
          /\ published \in BOOLEAN /\ rejected \in BOOLEAN /\ authority = Authority
AckDurable == acknowledged \subseteq durable
DocumentCovered == published => durable = Records
NoAuthorityRetirement == authority = Authority
BoundedPage == Paged => Fits(packet)
PrefixResume == acknowledged = 1..Cardinality(acknowledged)
EventuallyCovered == <> (durable = Records /\ acknowledged = Records /\ published)
=============================================================================
