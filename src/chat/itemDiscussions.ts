import { conversationRoots } from "./context"
import type { StoredChatMessage } from "./storePolicy"

export type ItemDiscussion = { count: number }
type DiscussionMessage = Omit<StoredChatMessage, "record">

// One board-wide index, rather than scanning the chat history for every card.
export function itemDiscussions(messages: readonly DiscussionMessage[], scope: string, boardId: string): Map<string, ItemDiscussion> {
  const saved = new Map(messages.filter(message => "record" in message && message.workspaceId === scope).map(message => [message.id, message]))
  const conversations = conversationRoots([...saved.values()])
  const roots = new Map<string, string>()
  const cardsByRoot = new Map<string, Set<string>>()
  for (const message of saved.values()) {
    const root = conversations.get(message.id)!
    const rootId = root.state === "invalid" ? message.id : root.rootId
    roots.set(message.id, rootId)
    const cards = cardsByRoot.get(rootId) ?? new Set<string>()
    for (const anchor of message.context?.references ?? []) {
      if (anchor.workspaceScope === scope && anchor.boardId === boardId) cards.add(anchor.itemId)
    }
    cardsByRoot.set(rootId, cards)
  }
  const summaries = new Map<string, ItemDiscussion>()
  for (const message of saved.values()) {
    for (const itemId of cardsByRoot.get(roots.get(message.id)!) ?? []) {
      const summary = summaries.get(itemId) ?? { count: 0 }
      summary.count++
      summaries.set(itemId, summary)
    }
  }
  return summaries
}
