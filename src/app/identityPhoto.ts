import { isAvatarDataUrl, isMemberProfileData } from "../domain/avatarData"
import type { PersonalRootDocumentV1 } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import { defaultStorage } from "../storage"

export type IdentityPhoto = NonNullable<PersonalRootDocumentV1["photo"]>
export function parseIdentityPhoto(value: unknown): IdentityPhoto | undefined {
  if (!value || !isMemberProfileData(JSON.stringify(value))) return undefined
  return value as IdentityPhoto
}
export function newerIdentityPhoto(left: IdentityPhoto | undefined, right: IdentityPhoto | undefined): IdentityPhoto | undefined {
  if (!left) return right
  if (!right) return left
  return left.changedAt > right.changedAt || left.changedAt === right.changedAt && (left.avatarData ?? "") >= (right.avatarData ?? "") ? left : right
}
export async function saveIdentityPhoto(profile: LocalProfile, avatarData: string | null,
  storage: Pick<typeof defaultStorage, "updatePersonalRootForIdentity"> = defaultStorage): Promise<IdentityPhoto> {
  if (avatarData !== null && !isAvatarDataUrl(avatarData)) throw new Error("Profile photo must be a small WebP or JPEG image")
  const root = await storage.updatePersonalRootForIdentity(profile.identity.personId, current => {
    if (current?.identity.personId !== profile.identity.personId) throw new Error("Identity catalog is unavailable")
    const previous = parseIdentityPhoto(current.photo)
    const changedAt = new Date(Math.max(Date.now(), previous ? Date.parse(previous.changedAt) + 1 : 0)).toISOString()
    return { ...current, photo: { avatarData, changedAt } }
  })
  if (!root?.photo) throw new Error("Identity catalog is unavailable")
  return root.photo
}
