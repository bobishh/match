import { reactive } from "vue"
import type { MessageContext } from "../chat/context"

export type ChatDraft = { body: string; context: MessageContext }
const drafts = new Map<string, ChatDraft>()
export function chatDraft(workspaceId: string, windowId: string, initial?: MessageContext): ChatDraft {
  const key = JSON.stringify([workspaceId, windowId])
  let draft = drafts.get(key)
  if (!draft) {
    draft = reactive({ body: "", context: JSON.parse(JSON.stringify(initial ?? { references: [], mentions: [] })) as MessageContext })
    drafts.set(key, draft)
  }
  return draft
}
