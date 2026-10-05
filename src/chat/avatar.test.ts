import { describe, expect, it } from "vitest"
import { participantAvatar } from "./avatar"

describe("participantAvatar version 1", () => {
  it("preserves a fixed visual identity contract across reloads and runtimes", () => {
    const personId = "A".repeat(43)
    const expected = {
      version: 1, neutral: false, background: "#bcdde8", faceColor: "#efd4e4",
      crown: "M16 13 Q15 4 21 7 Q25 1 29 8 Q35 5 33 15",
      face: "M15 13 Q24 9 33 13 L38 29 Q37 40 24 41 Q11 40 10 29 Z",
      eyes: "M17 22 L17 27 M30 22 L30 27",
      mouth: "M19 32 Q22 35 25 32 Q28 35 31 32",
    }
    expect(participantAvatar(personId)).toEqual(expected)
    expect(participantAvatar(personId)).toEqual(expected)
  })

  it("uses the end of the full identity rather than a shared prefix", () => {
    const first = participantAvatar("A".repeat(43))
    const second = participantAvatar("A".repeat(42) + "E")
    expect(second).toMatchObject({
      version: 1, neutral: false, background: "#c5ddd4", faceColor: "#efd4e4",
      crown: "M12 19 Q3 11 10 9 Q15 9 16 15 M32 15 Q35 8 40 10 Q46 15 36 20",
      face: "M12 18 Q15 11 24 12 Q35 12 37 22 Q42 38 25 41 Q9 40 10 27 Z",
    })
    expect(second).not.toEqual(first)
  })

  it("accepts base64url punctuation and preserves case-sensitive identity", () => {
    const personId = "a_-".repeat(14) + "A"
    expect(participantAvatar(personId).neutral).toBe(false)
    expect(participantAvatar(personId)).not.toEqual(participantAvatar(personId.toUpperCase()))
  })

  it.each([
    undefined, null, 12, {}, "", " ", "person", "A".repeat(42), "A".repeat(44),
    "A".repeat(42) + "B", "A".repeat(42) + "=", " A".repeat(21) + "A",
    "A".repeat(41) + "/A", "<svg onload=alert(1)>", "A".repeat(42) + "А",
  ])("uses one neutral placeholder for invalid input %j", (personId) => {
    expect(participantAvatar(personId)).toEqual(participantAvatar(null))
    expect(participantAvatar(personId)).toMatchObject({ neutral: true, crown: "" })
  })
})
