import { expect, it } from "vitest"
import type { Anchor } from "./context"
import type { StoredChatMessage } from "./storePolicy"
import { itemDiscussions } from "./itemDiscussions"

const anchor = { workspaceScope: "scope", boardId: "board", itemId: "card" }
function message(id: string, body: string, time: string, references: Anchor[] = [anchor]): StoredChatMessage {
  return { id, body, createdAt: time, workspaceId: "scope", personId: "person", record: {}, context: { references, mentions: [] } }
}

it("Given saved card messages and a reply without references, When messages are indexed, Then each card has a unique saved count", () => {
  const root = message("root", "First", "2026-10-09T12:00:00Z", [anchor, { ...anchor, fieldId: "title" }])
  const reply = message("reply", " Latest\n  message ", "2026-10-09T12:02:00Z", [])
  reply.context = { references: [], mentions: [], replyTo: root.id, conversationRootId: root.id }
  const middle = message("middle", "Middle", "2026-10-09T12:01:00Z")
  expect(itemDiscussions([reply, root, middle, root], "scope", "board").get("card"))
    .toEqual({ count: 3, messageId: "reply" })
})

it("Given drafts, failed sends and references to other boards or workspaces, When indexed, Then no discussion badge is counted", () => {
  const pending = { ...message("pending", "Unsent", "2026-10-09T12:00:00Z") } as Partial<StoredChatMessage>
  delete pending.record
  const otherWorkspace = { ...message("other", "Other", "2026-10-09T12:00:00Z"), workspaceId: "other" }
  const wrongBoard = message("wrong-board", "Wrong", "2026-10-09T12:00:00Z", [{ ...anchor, boardId: "other" }])
  const wrongScope = message("wrong-scope", "Wrong", "2026-10-09T12:00:00Z", [{ ...anchor, workspaceScope: "other" }])
  expect(itemDiscussions([pending as Omit<StoredChatMessage, "record">, otherWorkspace, wrongBoard, wrongScope], "scope", "board").size).toBe(0)
})

it("Given one message references multiple cards, When indexed, Then each referenced card has a count", () => {
  const shared = message("shared", "Shared", "2026-10-09T12:00:00Z", [anchor, { ...anchor, itemId: "other-card" }])
  expect(itemDiscussions([shared], "scope", "board")).toEqual(new Map([["card", { count: 1, messageId: "shared" }], ["other-card", { count: 1, messageId: "shared" }]]))
})

it("Given several card threads and an invalid reply, When indexed out of order, Then the latest valid saved message selects its thread", () => {
  const old = message("old", "Old thread", "2026-10-09T12:00:00Z")
  const recent = message("recent", "Recent thread", "2026-10-09T12:01:00Z")
  const reply = message("reply", "Old thread updated", "2026-10-09T12:02:00Z", [])
  reply.context = { references: [], mentions: [], replyTo: old.id, conversationRootId: old.id }
  const invalid = message("invalid", "Invalid reply", "2026-10-09T12:03:00Z")
  invalid.context = { references: [anchor], mentions: [], replyTo: old.id, conversationRootId: recent.id }
  expect(itemDiscussions([invalid, reply, recent, old], "scope", "board").get("card"))
    .toEqual({ count: 4, messageId: "reply" })
})
