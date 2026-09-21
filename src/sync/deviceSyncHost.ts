import {
  createPairingSecret,
  createWorkspaceJoinInvite,
  invitationUrl,
} from "@meta-uber/mesh-pairing"
import { defaultInvitationService } from "./invitations"
import type { LocalProfile } from "../domain/identity"
import type { SyncNode } from "./transport"
import type { WorkspaceReplica } from "./workspaceSet"
import { workspaceSet, type LiveWorkspaceSync } from "./workspaceSet"
import { startPersistentNode } from "./persistentNode"
import { userMessage } from "./deviceSyncState"
import { startWorkspaceHostController } from "./deviceSyncHostController"
import { showInviteQr } from "./deviceSyncInviteView"
import type { PairingContext } from "./deviceSyncContext"

type WorkspaceOption = { id: string; title: string }

export type WorkspaceHostContext = PairingContext & {
  workspace: WorkspaceReplica
  startMesh: (node?: SyncNode) => Promise<void>
  setNode: (node: SyncNode | undefined) => void
  getNode: () => SyncNode | undefined
  attachLiveSession: (session: LiveWorkspaceSync, run: number) => void
  detachLiveSession: (session: LiveWorkspaceSync) => void
  waitForJoinDecision: (personId: string, displayName: string) => Promise<"visitor" | "editor" | null>
  replaceDirectSession: (personId: string, session: LiveWorkspaceSync) => LiveWorkspaceSync | undefined
  removeDirectSession: (personId: string, session: LiveWorkspaceSync) => void
}

export async function generateWorkspaceInvite(context: WorkspaceHostContext) {
  if (context.state.selectedWorkspaceIds.value.length === 0) return
  try {
    await createWorkspaceHost(context)
  } catch (err) {
    console.error("generateWorkspaceInvite failed", err)
    context.state.step.value = "error"
    context.state.error.value = userMessage(err, "Couldn’t generate invite.")
  }
}

async function createWorkspaceHost(context: WorkspaceHostContext) {
  const profile = await context.getProfile()
  const workspaces = selectedWorkspaces(context)
  const owners = await workspaceOwners(context, workspaces, profile)
  await context.pauseMesh()
  await context.stopNode("Starting workspace host")
  const run = context.nextRun()
  clearHostNotice(context)
  const node = await startPersistentNode(context.transport)
  if (run !== context.currentRun()) return void node.close("Replaced")
  context.setNode(node)
  await context.durableMesh?.ensureOwnerWorkspaces(workspaces.map(item => item.id), node.endpointId, profile)
  const invite = await createHostInvite(context, node, profile, workspaces)
  if (!context.workspaceStore) throw new Error("Workspace sync is unavailable.")
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore, workspaces.map(item => item.id))
  context.state.liveWorkspaceIds.value = workspaces.map(item => item.id)
  await startWorkspaceHostController({ context, run, node, profile, invite, owners, workspaces, replica })
}

function selectedWorkspaces(context: WorkspaceHostContext) {
  const selected = context.state.selectedWorkspaceIds.value
  const available = context.availableWorkspaces.filter(item => selected.includes(item.id))
  return available.length > 0 ? available : selected.map(id => ({ id, title: "Workspace" }))
}

async function workspaceOwners(context: WorkspaceHostContext, workspaces: WorkspaceOption[], profile: LocalProfile) {
  const owners = new Map<string, string>()
  for (const workspace of workspaces) {
    const owner = context.workspaceOwner ? await context.workspaceOwner(workspace.id) : profile.identity.personId
    if (owner !== profile.identity.personId) throw new Error(`Only the workspace owner can invite peers to ${workspace.title}`)
    owners.set(workspace.id, owner)
  }
  return owners
}

function clearHostNotice(context: WorkspaceHostContext) {
  context.state.copyNotice.value = ""
  context.state.error.value = ""
}

async function createHostInvite(context: WorkspaceHostContext, node: SyncNode, profile: LocalProfile, workspaces: WorkspaceOption[]) {
  const secret = createPairingSecret()
  const invite = createWorkspaceJoinInvite(node.endpointId, secret, profile, workspaces)
  await defaultInvitationService.saveIssuedInvitation(invite)
  await showInviteQr(context.state, invitationUrl(context.origin(), invite))
  context.state.step.value = "workspace-host"
  return invite
}
