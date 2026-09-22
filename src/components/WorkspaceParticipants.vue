<script setup lang="ts">
import type { WorkspaceRole } from "../domain/permissions"

defineProps<{
  members: Array<{ personId: string; name: string }>
  currentPersonId: string
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
      <li v-for="member in members" :key="member.personId">
        <strong>{{ member.name }}</strong>
        <span>{{ roleFor(member, peers, ownerPersonId, currentPersonId, currentRole) }}{{ member.personId === currentPersonId ? ' · You' : '' }}</span>
      </li>
    </ul>
    <template v-if="canManageAccess && peers.length">
      <h4>Trusted peer devices</h4>
      <ul>
        <li v-for="peer in peers" :key="peer.deviceId" class="peer-device-row">
          <span><strong>{{ peer.name }}</strong><small>{{ peer.online ? 'Online' : 'Offline' }} · {{ peer.role }}</small></span>
          <button v-if="!peer.revokedAt" class="button button-danger" type="button" :disabled="Boolean(revokingPersonId)" @click="emit('revoke', peer.personId)">Remove access</button>
          <span v-else>Revoked</span>
        </li>
      </ul>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
