import { describe, expect, it } from "vitest"
import { messageReferenceUrl, parseMessageReference } from "./messageReference"

const target = { workspaceScope: "workspace:original-abc", messageId: "device_abc:message-123" }
const fragment = (value: unknown) => `#message=${encodeURIComponent(JSON.stringify(value))}`

describe("message references", () => {
  it("round-trips a versioned canonical target while preserving deployment path and query", () => {
    const url = new URL(messageReferenceUrl("https://example.test/deployed/app/?locale=ru#previous", target))
    expect(url.pathname).toBe("/deployed/app/")
    expect(url.search).toBe("?locale=ru")
    expect(parseMessageReference(url.hash)).toEqual({ status: "valid", reference: { version: 1, ...target } })
    expect(Object.keys(JSON.parse(decodeURIComponent(url.hash.slice(9)))).sort()).toEqual(["messageId", "version", "workspaceScope"])
  })

  it.each(["", "#other=1", "#invite=secret", "#login=code"])("leaves unrelated routing fragment %j alone", hash => {
    expect(parseMessageReference(hash)).toEqual({ status: "none" })
  })

  it.each([
    "#message=", "#message=%ZZ", "#message=%7Bbroken", "#message=" + "a".repeat(2048),
    fragment(null), fragment([]), fragment({ ...target }), fragment({ version: 2, ...target }),
    fragment({ version: "1", ...target }), fragment({ version: 1, ...target, secret: "untrusted" }),
    fragment({ version: 1, ...target, workspaceScope: "" }),
    fragment({ version: 1, ...target, messageId: " " }),
    fragment({ version: 1, ...target, messageId: "<script>" }),
    fragment({ version: 1, ...target, messageId: "a".repeat(161) }),
  ])("rejects malformed/unsupported reference %j", hash => {
    expect(parseMessageReference(hash)).toEqual({ status: "invalid" })
  })

  it("rejects unsafe output protocols and invalid targets", () => {
    expect(() => messageReferenceUrl("javascript:alert(1)", target)).toThrow("Invalid message URL")
    expect(() => messageReferenceUrl("https://example.test", { ...target, messageId: "" })).toThrow("Invalid message reference")
  })
})
