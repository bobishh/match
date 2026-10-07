import { describe, expect, it } from "vitest"
import { isAvatarDataUrl } from "./avatarData"

const validWebp128 = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
const invalidWebp64 = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAPwAAfwAA"
const jpeg128 = "data:image/jpeg;base64,/9j/wAARCACAAIADAREAAhEAAxEA/9k="

describe("member avatar image bounds", () => {
  it("accepts bounded 128 by 128 WebP and JPEG data", () => {
    expect(isAvatarDataUrl(validWebp128)).toBe(true)
    expect(isAvatarDataUrl(jpeg128)).toBe(true)
  })

  it("rejects malformed bytes, mismatched dimensions, and oversized payloads", () => {
    expect(isAvatarDataUrl("data:image/webp;base64,AA==")).toBe(false)
    expect(isAvatarDataUrl(invalidWebp64)).toBe(false)
    expect(isAvatarDataUrl(`data:image/jpeg;base64,${"A".repeat(22_000)}`)).toBe(false)
  })
})
