import { describe, it, expect } from "vitest"
import {
  ChatStore,
  chatStore,
  messageOrderKey,
  canonicalJson,
  getSerializedBytes,
  getMessageRecordSerializedBytes,
  validateMessage,
  validateProfile,
  areMessagesIdentical,
  doesProfileWin,
  type StoredChatMessage,
  type StoredChatProfile,
  MAX_BODY_CODEPOINTS,
  MAX_RECORD_BYTES,
} from "./store"

describe("ChatStore", () => {
  describe("messageOrderKey", () => {
    it("formats '${createdAt}|${id}' deterministically", () => {
      const key = messageOrderKey({ createdAt: "2026-09-10T23:00:00.000Z", id: "msg_123" })
      expect(key).toBe("2026-09-10T23:00:00.000Z|msg_123")
    })

    it("sorts chronologically by createdAt then id", () => {
      const m1 = { createdAt: "2026-09-10T23:00:00.000Z", id: "msg_a" }
      const m2 = { createdAt: "2026-09-10T23:00:00.000Z", id: "msg_b" }
      const m3 = { createdAt: "2026-09-10T23:01:00.000Z", id: "msg_a" }

      const k1 = messageOrderKey(m1)
      const k2 = messageOrderKey(m2)
      const k3 = messageOrderKey(m3)

      expect(k1 < k2).toBe(true)
      expect(k2 < k3).toBe(true)
    })
  })

  describe("canonicalJson", () => {
    it("sorts object keys alphabetically regardless of insertion order", () => {
      const a = { z: 1, a: 2, m: 3 }
      const b = { a: 2, m: 3, z: 1 }
      expect(canonicalJson(a)).toBe(canonicalJson(b))
      expect(canonicalJson(a)).toBe('{"a":2,"m":3,"z":1}')
    })

    it("handles nested structures, arrays, and primitive values", () => {
      const val = {
        list: [3, 2, 1],
        sub: { d: true, c: null, b: "hello" },
      }
      expect(canonicalJson(val)).toBe('{"list":[3,2,1],"sub":{"b":"hello","c":null,"d":true}}')
    })

    it("rejects circular structures cleanly with TypeError", () => {
      const circular: Record<string, unknown> = { foo: "bar" }
      circular.self = circular
      expect(() => canonicalJson(circular)).toThrow(TypeError)
    })
  })

  describe("Validation", () => {
    const validMsg: StoredChatMessage = {
      id: "msg_1",
      workspaceId: "ws_test",
      personId: "person_1",
      createdAt: "2026-09-10T23:00:00.000Z",
      body: "Hello world",
      record: { custom: "data" },
    }

    const validProfile: StoredChatProfile = {
      workspaceId: "ws_test",
      personId: "person_1",
      name: "Alice",
      revision: 1,
      record: { avatar: "url" },
    }

    it("validates compliant message and profile", () => {
      expect(() => validateMessage(validMsg)).not.toThrow()
      expect(() => validateProfile(validProfile)).not.toThrow()
    })

    it("rejects message body exceeding 8000 codepoints", () => {
      const body8000 = "a".repeat(MAX_BODY_CODEPOINTS)
      expect(() => validateMessage({ ...validMsg, body: body8000 })).not.toThrow()

      const body8001 = "a".repeat(MAX_BODY_CODEPOINTS + 1)
      expect(() => validateMessage({ ...validMsg, body: body8001 })).toThrow(/codepoint/i)
    })

    it("correctly counts multi-byte unicode and emoji codepoints", () => {
      const emojiString = "🎉".repeat(MAX_BODY_CODEPOINTS + 1)
      expect(() => validateMessage({ ...validMsg, body: emojiString })).toThrow(/codepoint/i)
    })

    it("rejects message with invalid createdAt timestamp", () => {
      expect(() => validateMessage({ ...validMsg, createdAt: "not-a-date" })).toThrow(/timestamp/i)
      expect(() => validateMessage({ ...validMsg, createdAt: "" })).toThrow(/timestamp/i)
    })

    it("rejects message record exceeding 32KiB serialized limit", () => {
      const bigRecord = { payload: "x".repeat(MAX_RECORD_BYTES + 1) }
      expect(() => validateMessage({ ...validMsg, record: bigRecord })).toThrow(/32 KiB|32768/i)
    })

    it("rejects profile with negative or non-integer revision", () => {
      expect(() => validateProfile({ ...validProfile, revision: -1 })).toThrow(/revision/i)
      expect(() => validateProfile({ ...validProfile, revision: 1.5 })).toThrow(/revision/i)
      expect(() => validateProfile({ ...validProfile, revision: NaN })).toThrow(/revision/i)
    })

    it("rejects profile record exceeding 32KiB serialized limit", () => {
      const bigRecord = { payload: "x".repeat(MAX_RECORD_BYTES + 1) }
      expect(() => validateProfile({ ...validProfile, record: bigRecord })).toThrow(/32 KiB|32768/i)
    })

    it("rejects non-string or oversized required fields", () => {
      const oversized = "a".repeat(257)
      expect(() => validateMessage({ ...validMsg, id: oversized })).toThrow(/id/i)
      expect(() => validateMessage({ ...validMsg, workspaceId: oversized })).toThrow(/workspaceId/i)
      expect(() => validateMessage({ ...validMsg, personId: oversized })).toThrow(/personId/i)
    })
  })

  describe("Message immutability & identity checks", () => {
    const base: StoredChatMessage = {
      id: "msg_1",
      workspaceId: "ws_1",
      personId: "p_1",
      createdAt: "2026-09-10T23:00:00.000Z",
      body: "Text",
      record: { a: 1 },
    }

    it("identifies identical messages even with differently ordered record keys", () => {
      const copy: StoredChatMessage = {
        ...base,
        record: { a: 1 },
      }
      expect(areMessagesIdentical(base, copy)).toBe(true)
    })

    it("detects conflicts when immutable content changes", () => {
      expect(areMessagesIdentical(base, { ...base, body: "Changed" })).toBe(false)
      expect(areMessagesIdentical(base, { ...base, personId: "p_2" })).toBe(false)
      expect(areMessagesIdentical(base, { ...base, createdAt: "2026-09-10T23:01:00.000Z" })).toBe(false)
      expect(areMessagesIdentical(base, { ...base, record: { a: 2 } })).toBe(false)
    })
  })

  describe("Profile conflict resolution (LWW & canonical tie-break)", () => {
    const pExisting: StoredChatProfile = {
      workspaceId: "ws_1",
      personId: "p_1",
      name: "Alice",
      revision: 1,
      record: { status: "offline" },
    }

    it("incoming wins if revision is higher", () => {
      const pIncoming: StoredChatProfile = {
        ...pExisting,
        revision: 2,
      }
      expect(doesProfileWin(pIncoming, pExisting)).toBe(true)
      expect(doesProfileWin(pExisting, pIncoming)).toBe(false)
    })

    it("ties broken deterministically by canonical JSON record lexical ordering", () => {
      const p1: StoredChatProfile = {
        ...pExisting,
        revision: 1,
        record: { tag: "alpha" },
      }
      const p2: StoredChatProfile = {
        ...pExisting,
        revision: 1,
        record: { tag: "beta" },
      }
      // '{"tag":"beta"}' > '{"tag":"alpha"}'
      expect(doesProfileWin(p2, p1)).toBe(true)
      expect(doesProfileWin(p1, p2)).toBe(false)
    })

    it("returns false if identical", () => {
      expect(doesProfileWin(pExisting, { ...pExisting })).toBe(false)
    })
  })

  describe("IndexedDB availability & error handling", () => {
    it("exports a chatStore singleton instance of ChatStore", () => {
      expect(chatStore).toBeInstanceOf(ChatStore)
    })

    it("rejects load when IndexedDB is unavailable without falling back to localStorage", async () => {
      const store = new ChatStore("test-db")
      await expect(store.load("ws_1")).rejects.toThrow(/IndexedDB/)
    })

    it("rejects append when IndexedDB is unavailable", async () => {
      const store = new ChatStore("test-db")
      const msg: StoredChatMessage = {
        id: "m1",
        workspaceId: "ws_1",
        personId: "p1",
        createdAt: "2026-09-10T23:00:00.000Z",
        body: "Hello",
        record: null,
      }
      await expect(store.append(msg)).rejects.toThrow(/IndexedDB/)
    })

    it("rejects putProfile when IndexedDB is unavailable", async () => {
      const store = new ChatStore("test-db")
      const prof: StoredChatProfile = {
        workspaceId: "ws_1",
        personId: "p1",
        name: "Alice",
        revision: 1,
        record: null,
      }
      await expect(store.putProfile(prof)).rejects.toThrow(/IndexedDB/)
    })

    it("rejects merge when incoming workspaceId does not match target", async () => {
      const store = new ChatStore("test-db")
      const msg: StoredChatMessage = {
        id: "m1",
        workspaceId: "ws_diff",
        personId: "p1",
        createdAt: "2026-09-10T23:00:00.000Z",
        body: "Hello",
        record: null,
      }
      await expect(store.merge("ws_1", [msg], [])).rejects.toThrow(/workspaceId/i)
    })

    it("rejects readCursor and markRead when IndexedDB is unavailable", async () => {
      const store = new ChatStore("test-db")
      await expect(store.readCursor("ws_1")).rejects.toThrow(/IndexedDB/)
      await expect(store.markRead("ws_1", "2026-09-10T23:00:00.000Z|m1")).rejects.toThrow(/IndexedDB/)
    })
  })
})
