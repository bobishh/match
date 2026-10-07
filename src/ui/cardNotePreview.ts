const CARD_NOTE_PREVIEW_LIMIT = 320

export function previewCardNote(source: string, searchQuery = "", match = -1) {
  const query = searchQuery.trim()
  const matchIndex = validNoteMatch(source, query, match) ? match : -1
  const limit = Math.min(Math.max(CARD_NOTE_PREVIEW_LIMIT, query.length + 80), 2_000)
  if (source.length <= limit) return source
  let start = matchIndex >= limit || matchIndex + query.length > limit ? Math.max(0, matchIndex - 120) : 0
  if (start > 0) {
    const wordStart = source.lastIndexOf(" ", start)
    if (wordStart >= start - 40) start = wordStart + 1
  }
  const excerpt = source.slice(start, start + limit)
  const paragraphEnd = excerpt.lastIndexOf("\n\n")
  const wordEnd = excerpt.lastIndexOf(" ")
  let end = paragraphEnd >= limit / 2 ? paragraphEnd : wordEnd
  if (matchIndex >= start && matchIndex < start + limit) {
    end = Math.max(end, Math.min(limit, matchIndex - start + query.length + 48))
  }
  const prefix = start > 0 ? "…\n\n" : ""
  const suffix = start + end < source.length ? "\n\n…" : ""
  return `${prefix}${excerpt.slice(0, end > 0 ? end : limit).trimEnd()}${suffix}`
}

function validNoteMatch(source: string, query: string, match: number) {
  return match >= 0 && match + query.length <= source.length &&
    source.slice(match, match + query.length).toLowerCase() === query.toLowerCase()
}
