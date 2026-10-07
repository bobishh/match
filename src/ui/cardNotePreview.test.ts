import { describe, expect, it } from "vitest"
import { previewCardNote } from "./cardNotePreview"

describe("card note search previews", () => {
  it("keeps complete short notes unchanged without a search query", () => {
    const note = "First paragraph.\n\nSecond paragraph."
    expect(previewCardNote(note)).toBe(note)
    expect(previewCardNote("")).toBe("")
  })

  it("keeps an early search match in a bounded preview", () => {
    const note = "Portfolio link available on request. " + "Detailed requirements. ".repeat(80)
    const preview = previewCardNote(note, "portfolio", 0)

    expect(preview).toContain("Portfolio link available on request.")
    expect(preview.length).toBeLessThan(500)
    expect(preview).toContain("…")
  })

  it("moves the excerpt to a late match and keeps nearby context", () => {
    const note = "Earlier requirements. ".repeat(80) + "Portfolio link available on request."
    const match = note.toLowerCase().indexOf("portfolio")
    const preview = previewCardNote(note, "portfolio", match)

    expect(preview).toContain("Portfolio link available on request.")
    expect(preview.startsWith("…")).toBe(true)
    expect(preview.length).toBeLessThan(500)
  })

  it("uses the default excerpt for stale or out-of-range match offsets", () => {
    const note = "Opening details. " + "Later detail. ".repeat(80)
    const preview = previewCardNote(note, "absent", note.length + 20)

    expect(preview.startsWith("Opening details.")).toBe(true)
    expect(preview).toContain("…")
    expect(preview.length).toBeLessThan(500)
  })

  it("bounds long queries and leaves the source note intact", () => {
    const note = "Intro. " + "Context. ".repeat(250) + "Distinctive ending."
    const original = note
    const query = "Distinctive ending"
    const preview = previewCardNote(note, query, note.indexOf(query))

    expect(preview).toContain(query)
    expect(preview.length).toBeLessThan(2_100)
    expect(note).toBe(original)
  })
})
