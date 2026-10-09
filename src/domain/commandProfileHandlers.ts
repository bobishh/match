import type { CommandHandler } from "./commandHandlerTypes"
import { err } from "./commandTypes"
import { isAvatarDataUrl, memberProfileEntityId } from "./avatarData"
import { hasEntityKind } from "./model"

export const setMemberAvatar: CommandHandler<"setMemberAvatar"> = (doc, command, context) => {
  const personId = context.actorPersonId
  if (!personId) return err("permission_denied", "Profile change has no authenticated person")
  if (command.avatarData !== null && !isAvatarDataUrl(command.avatarData)) {
    return err("invalid_input", "Avatar must be a small WebP or JPEG image", "avatarData")
  }
  const profileId = memberProfileEntityId(personId)
  const existing = doc.entities[profileId]
  if (existing && !hasEntityKind(existing, "member_profile")) return err("invalid_input", "Profile entity ID conflicts with another record")
  if (command.avatarData === null && !existing && !command.changedAt) return err("invalid_input", "No custom avatar to remove")
  const createdAt = hasEntityKind(existing, "member_profile") ? existing.createdAt : context.nowIso
  const changedAt = command.changedAt ?? context.nowIso
  if (!Number.isFinite(Date.parse(changedAt)) || new Date(changedAt).toISOString() !== changedAt) return err("invalid_input", "Profile timestamp must be ISO", "changedAt")
  const data = command.avatarData === null && !command.changedAt ? undefined : JSON.stringify({ avatarData: command.avatarData, changedAt })
  return { ok: true, value: { changedEntityIds: [profileId], apply: draft => {
    if (!data) delete draft.entities[profileId]
    else draft.entities[profileId] = {
      id: profileId, kind: "member_profile", personId, data, title: "Member profile",
      placement: { parentId: null, rank: "0/1" }, archivedAt: null, createdAt, updatedAt: context.nowIso,
    }
  } } }
}
