import { computed, type Ref } from "vue"
import { memberAvatarData } from "../domain/avatarData"
import type { WorkspaceDocumentV2 } from "../domain/model"

export function useMemberAvatars(docVersion: Ref<number>, getActiveDoc: () => WorkspaceDocumentV2 | null | undefined,
  getPersonId: () => string | undefined, persist: (avatarData: string | null) => Promise<void>) {
  const memberAvatars = computed<Record<string, string>>(() => {
    void docVersion.value
    return Object.fromEntries(Object.values(getActiveDoc()?.entities ?? {}).flatMap(entity => {
      if (entity.kind !== "member_profile") return []
      const data = memberAvatarData(entity.data)
      return data ? [[entity.personId, data]] : []
    }))
  })
  const currentAvatar = computed(() => memberAvatars.value[getPersonId() ?? ""])
  return { memberAvatars, currentAvatar, saveAvatar: persist }
}
