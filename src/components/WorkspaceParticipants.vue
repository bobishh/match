<script setup lang="ts">
import type { WorkspaceRole } from "../domain/permissions"
import ParticipantAvatar from "./ParticipantAvatar.vue"

defineProps<{
  members: Array<{ personId: string; name: string }>
  currentPersonId: string
  currentIdentityName: string
  currentRole: WorkspaceRole
  ownerPersonId: string
  peers: Array<{ deviceId: string; personId: string; name: string; online: boolean; role: WorkspaceRole; revokedAt?: string | null }>
  canManageAccess: boolean
  revokingPersonId: string
  error: string
}>()

const emit = defineEmits<{ revoke: [personId: string] }>()

function roleFor(member: { personId: string }, peers: Array<{ personId: string; role: WorkspaceRole }>, ownerPersonId: string, currentPersonId: string, currentRole: WorkspaceRole) {
  if (member.personId === ownerPersonId) return "Owner"
  if (member.personId === currentPersonId) return currentRole
  return peers.find(peer => peer.personId === member.personId)?.role ?? "Member"
}
</script>

<template>
  <section class="chat-members" aria-label="Known workspace participants">
    <h3>Participants</h3>
    <p>{{ canManageAccess ? 'Trusted devices and current connection state.' : 'Participants known to this device.' }}</p>
    <ul>
      <li v-for="member in members" :key="member.personId" class="participant-row">
        <div class="participant-name"><ParticipantAvatar :person-id="member.personId" /><strong>{{ member.personId === currentPersonId ? currentIdentityName : member.name }}</strong></div>
        <span>{{ roleFor(member, peers, ownerPersonId, currentPersonId, currentRole) }}{{ member.personId === currentPersonId ? ' · You' : '' }}</span>
      </li>
    </ul>
    <template v-if="canManageAccess && peers.length">
      <h4>Trusted peer devices</h4>
      <ul>
        <li v-for="peer in peers" :key="peer.deviceId" class="peer-device-row">
          <div class="participant-name"><ParticipantAvatar :person-id="peer.personId" /><div class="participant-device-name"><strong>{{ peer.name }}</strong><small>{{ peer.online ? 'Online' : 'Offline' }} · {{ peer.role }}</small></div></div>
          <button v-if="!peer.revokedAt" class="button button-danger" type="button" :disabled="Boolean(revokingPersonId)" @click="emit('revoke', peer.personId)">Remove access</button>
          <span v-else>Revoked</span>
        </li>
      </ul>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.participant-row { align-items: center; }
.participant-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.participant-name strong { min-width: 0; overflow-wrap: anywhere; }
.participant-device-name { display: grid; gap: 4px; min-width: 0; }
</style>
