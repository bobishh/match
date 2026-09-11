/**
 * Pure display name utilities for Match chat.
 * No Vue, persistence, or networking dependencies.
 */

const CONTROL_CHARS_REGEX = /\p{Cc}/u
const BIDI_CONTROL_REGEX = /\p{Bidi_Control}/u

const ADJECTIVES = [
  "Restless",
  "Thoughtful",
  "Bold",
  "Sunny",
  "Sparkling",
  "Radiant",
  "Brave",
  "Gentle",
  "Cozy",
  "Fluffy",
  "Attentive",
  "Swift",
  "Wise",
  "Cheerful",
  "Lively",
  "Tender",
  "Playful",
  "Spry",
  "Curious",
  "Kind",
  "Dreamy",
  "Mischievous",
  "Calm",
  "Joyful",
  "Nimble",
  "Valiant",
  "Inspired",
  "Mysterious",
] as const

const NOUNS = [
  "Mimosa",
  "Capybara",
  "Petunia",
  "Otter",
  "Panda",
  "Llama",
  "Comet",
  "Daisy",
  "Cinnamon",
  "Caramel",
  "Blueberry",
  "Raspberry",
  "Fox",
  "Owl",
  "Squirrel",
  "Swallow",
  "Spark",
  "Violet",
  "Vanilla",
  "Mint",
  "Papaya",
  "Magnolia",
  "Snail",
  "Turtle",
  "Heron",
  "Acacia",
  "Koala",
  "Marten",
] as const

/**
 * NFKC normalize, collapse Unicode whitespace runs to a single space, and trim.
 */
export function normalizeDisplayName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
}

/**
 * Validates a display name:
 * - 1..48 Unicode codepoints
 * - No control characters (Unicode category Cc)
 * - No bidirectional control characters (Bidi_Control)
 * Returns null if valid, or an English human-readable error string if invalid.
 */
export function validateDisplayName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return "Display name cannot be empty."
  }
  if (CONTROL_CHARS_REGEX.test(name)) {
    return "Display name cannot contain control characters."
  }
  if (BIDI_CONTROL_REGEX.test(name)) {
    return "Display name cannot contain bidirectional control characters."
  }
  const normalized = normalizeDisplayName(name)
  const codepoints = [...normalized].length
  if (codepoints === 0) {
    return "Display name cannot be empty."
  }
  if (codepoints > 48) {
    return "Display name cannot exceed 48 characters."
  }
  return null
}

/**
 * Normalized lowercase deterministic name key (not locale-specific).
 */
export function nameKey(name: string): string {
  return normalizeDisplayName(name).toLowerCase()
}

function getRandomIndex(length: number): number {
  const max = Math.floor(0x100000000 / length) * length
  const buffer = new Uint32Array(1)
  do {
    crypto.getRandomValues(buffer)
  } while (buffer[0] >= max)
  return buffer[0] % length
}

/**
 * Generates a friendly English adjective + noun.
 * Cryptographically random from broad dictionaries (~28 each).
 */
export function randomDisplayName(): string {
  const adj = ADJECTIVES[getRandomIndex(ADJECTIVES.length)]
  const noun = NOUNS[getRandomIndex(NOUNS.length)]
  return `${adj} ${noun}`
}

/**
 * Injective encoding of arbitrary string (including base64url cryptographic ID)
 * into safe alphanumeric ASCII ([0-9A-Za-z]).
 * Case-sensitive mapping ensures distinct IDs never collapse.
 */
function encodeIdToAlphanumeric(id: string): string {
  let result = ""
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "1" && ch <= "9")
    ) {
      result += ch
    } else if (ch === "0") {
      result += "00"
    } else if (ch === "-") {
      result += "01"
    } else if (ch === "_") {
      result += "02"
    } else {
      const code = ch.codePointAt(0) ?? ch.charCodeAt(0)
      result += "03" + code.toString(16) + "z"
    }
  }
  return result || "00"
}

interface DistinctPerson {
  personId: string
  chosenName: string
  key: string
  encodedId: string
}

/**
 * Resolves display names for a list of people:
 * - Group equal normalized keys.
 * - Unique names displayed as normalized name without suffix.
 * - For collisions, all distinct persons receive `name · X`.
 * - Suffix is derived deterministically from personId and extended until unique.
 * - Stable regardless of input order.
 * - Same person duplicates do not collide with self.
 */
export function resolveDisplayNames(
  people: readonly { personId: string; name: string }[]
): Record<string, string> {
  const result: Record<string, string> = {}
  if (!people || people.length === 0) {
    return result
  }

  // Deduplicate by personId to ensure same-person duplicates don't collide with self
  const byPersonId = new Map<string, string[]>()
  for (const p of people) {
    const list = byPersonId.get(p.personId)
    if (list) {
      list.push(p.name)
    } else {
      byPersonId.set(p.personId, [p.name])
    }
  }

  // Stable regardless of input order: sort person IDs deterministically
  const sortedPersonIds = Array.from(byPersonId.keys()).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  )

  const distinctPeople: DistinctPerson[] = []
  for (const personId of sortedPersonIds) {
    const rawNames = byPersonId.get(personId)!
    const normalizedNames = rawNames
      .map((n) => normalizeDisplayName(n))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const chosenName = normalizedNames[0]
    const key = nameKey(chosenName)
    const encodedId = encodeIdToAlphanumeric(personId)
    distinctPeople.push({ personId, chosenName, key, encodedId })
  }

  // Group equal normalized keys
  const groups = new Map<string, DistinctPerson[]>()
  for (const person of distinctPeople) {
    const group = groups.get(person.key)
    if (group) {
      group.push(person)
    } else {
      groups.set(person.key, [person])
    }
  }

  // For each group, resolve display names
  for (const [, group] of groups) {
    if (group.length === 1) {
      // Unique name displayed as normalized name
      result[group[0].personId] = group[0].chosenName
    } else {
      // For collisions, all distinct persons receive name · X
      group.sort((a, b) =>
        a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0
      )

      const personSuffixData = group.map((p) => ({
        person: p,
        len: 1,
      }))

      while (true) {
        const suffixes = personSuffixData.map(
          (d) => d.person.encodedId.slice(0, d.len) || d.person.encodedId
        )
        const counts = new Map<string, number>()
        for (const s of suffixes) {
          counts.set(s, (counts.get(s) ?? 0) + 1)
        }

        let anyExtended = false
        for (let i = 0; i < personSuffixData.length; i++) {
          const s = suffixes[i]
          if ((counts.get(s) ?? 0) > 1) {
            if (
              personSuffixData[i].len <
              personSuffixData[i].person.encodedId.length
            ) {
              personSuffixData[i].len++
              anyExtended = true
            }
          }
        }

        if (!anyExtended) {
          break
        }
      }

      for (const d of personSuffixData) {
        const suffix = d.person.encodedId.slice(0, d.len) || d.person.encodedId
        result[d.person.personId] = `${d.person.chosenName} · ${suffix}`
      }
    }
  }

  return result
}
