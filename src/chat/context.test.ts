import { describe, expect, it } from "vitest"
import { conversationMessages, conversationRoot, normalizeMessageContext, resolveAnchorSelection, validateMessageContext, type Anchor, type MessageContext } from "./context"
import type { StoredChatMessage } from "./store"
const anchor: Anchor = { workspaceScope: "ws", boardId: "board", itemId: "item" }
const context = (references = [anchor]): MessageContext => ({ references, mentions: [] })
const message = (id: string, value?: MessageContext): StoredChatMessage => ({ id, workspaceId: "ws", personId: "person", body: id, createdAt: "2026-10-05T00:00:00.000Z", record: {}, ...(value ? { context: value } : {}) })

describe("context bounds and conversation projection", () => {
  it("bounds and isolates signed anchors, mentions, selection, and reply identity", () => {
    expect(() => validateMessageContext(context(), "ws")).not.toThrow()
    for (const invalid of [context(Array(9).fill(anchor)), { ...context(), mentions: ["a", "a"] }, context([{ ...anchor, workspaceScope: "other" }]), { ...context(), replyTo: "self", conversationRootId: "self" }, { ...context(), unsigned: true }]) {
      expect(() => validateMessageContext(invalid, "ws", "self")).toThrow("Invalid message context")
    }
  })
  it("normalizes reply to reply into sibling with inherited references", () => {
    const root = message("root", context())
    const reply = message("reply", { ...context([]), replyTo: "root", conversationRootId: "root" })
    expect(normalizeMessageContext({ ...context([]), replyTo: "reply" }, [root, reply], "ws")).toEqual({ ...context(), replyTo: "reply", conversationRootId: "root" })
  })
  it("projects each multi-anchor message once and includes indirect replies", () => {
    const root = message("root", context([anchor, { ...anchor, itemId: "other" }]))
    const reply = message("reply", { ...context([]), replyTo: "root", conversationRootId: "root" })
    expect(conversationMessages([root, reply], { anchor }).map(value => value.id)).toEqual(["root", "reply"])
    expect(conversationMessages([root, reply], { anchor: { ...anchor, itemId: "other" } })).toEqual([root, reply])
  })
  it("groups interleaved roots with one ordered sibling level while preserving the original global log", () => {
    const first = message("first-root", context())
    first.createdAt = "2026-10-05T00:00:00.000Z"
    const second = message("second-root", context())
    second.createdAt = "2026-10-05T00:01:00.000Z"
    const firstReply = message("first-reply", { ...context([]), replyTo: first.id, conversationRootId: first.id })
    firstReply.createdAt = "2026-10-05T00:02:00.000Z"
    const secondReply = message("second-reply", { ...context([]), replyTo: second.id, conversationRootId: second.id })
    secondReply.createdAt = "2026-10-05T00:03:00.000Z"
    const sibling = message("reply-to-first-reply", { ...context([]), replyTo: firstReply.id, conversationRootId: first.id })
    sibling.createdAt = "2026-10-05T00:04:00.000Z"
    const log = [first, second, firstReply, secondReply, sibling]
    expect(conversationMessages(log, { anchor })).toEqual([first, firstReply, sibling, second, secondReply])
    expect(conversationMessages(log, { rootId: first.id })).toEqual([first, firstReply, sibling])
    expect(log).toEqual([first, second, firstReply, secondReply, sibling])
  })

  it("accepts missing parent, resolves later, isolates inconsistent roots and cycles", () => {
    const root = message("root", context())
    const reply = message("reply", { ...context([]), replyTo: "root", conversationRootId: "root" })
    expect(conversationRoot(reply, [reply])).toEqual({ rootId: "root", state: "unavailable" })
    expect(conversationRoot(reply, [root, reply])).toEqual({ rootId: "root", state: "resolved" })
    const wrong = message("wrong", { ...context([]), replyTo: "reply", conversationRootId: "different" })
    expect(conversationRoot(wrong, [root, reply, wrong]).state).toBe("invalid")
    expect(conversationMessages([root, reply, wrong], { rootId: "root" })).toEqual([root, reply])
    const cycle = message("root", { ...context([]), replyTo: "reply", conversationRootId: "root" })
    expect(conversationRoot(reply, [cycle, reply]).state).toBe("invalid")
  })
})
describe("safe quote resolution", () => {
  const selection = { exact: "salary", prefix: "a ", suffix: "!", start: 2, end: 8 }
  it("verifies captured range and relocates unique contextual match", () => {
    expect(resolveAnchorSelection("a salary!", selection)).toEqual({ state: "exact", start: 2, end: 8 })
    expect(resolveAnchorSelection("new a salary!", selection)).toEqual({ state: "relocated", start: 6, end: 12 })
  })
  it("never guesses ambiguous, missing, or deleted source", () => {
    expect(resolveAnchorSelection("new a salary! and a salary!", selection)).toEqual({ state: "changed" })
    expect(resolveAnchorSelection("another salary", selection)).toEqual({ state: "changed" })
    expect(resolveAnchorSelection(undefined, selection)).toEqual({ state: "unavailable" })
  })
})
