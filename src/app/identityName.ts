import { ensureChatProfile } from "../chat/service"
import { renameIdentity } from "../domain/identity"
import { defaultStorage } from "../storage"

export async function saveIdentityName(name: string, workspaceId: string, refreshIdentity: () => Promise<void>) {
  const profile = await renameIdentity(name)
  const root = await defaultStorage.loadPersonalRoot()
  if (root) await defaultStorage.savePersonalRoot({ ...root, identity: { ...root.identity, displayName: profile.identity.displayName } })
  await refreshIdentity()
  await ensureChatProfile(workspaceId)
}
