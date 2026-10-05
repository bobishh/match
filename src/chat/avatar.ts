// Version 1 is a visual identity contract: keep its palette, geometry and hash stable.
const backgroundColors = ["#f5d88b", "#c9dfbd", "#bcdde8", "#e4c6dd", "#efbca5", "#d0c9ed", "#c5ddd4", "#e8d8bd"] as const
const faceColors = ["#f7eed6", "#dfedc9", "#cce7eb", "#efd4e4", "#f2c8b2", "#ddd5ef"] as const
const crowns = [
  "M12 17 Q7 3 16 9 L20 15 M27 15 L32 8 Q40 3 35 18",
  "M14 15 L13 5 L22 12 M26 12 L35 5 L34 17",
  "M16 13 Q15 4 21 7 Q25 1 29 8 Q35 5 33 15",
  "M12 19 Q3 11 10 9 Q15 9 16 15 M32 15 Q35 8 40 10 Q46 15 36 20",
] as const
const faces = [
  "M12 16 Q24 9 36 16 L37 29 Q36 41 24 41 Q11 40 11 29 Z",
  "M12 18 Q15 11 24 12 Q35 12 37 22 Q42 38 25 41 Q9 40 10 27 Z",
  "M11 18 Q24 11 37 18 L35 34 Q24 45 13 34 Z",
  "M15 13 Q24 9 33 13 L38 29 Q37 40 24 41 Q11 40 10 29 Z",
] as const
const eyes = [
  "M17 23 L17 25 M30 23 L30 25",
  "M15 24 Q18 20 21 24 M27 24 Q30 20 33 24",
  "M16 22 L20 24 L16 25 M32 22 L28 24 L32 25",
  "M17 22 L17 27 M30 22 L30 27",
] as const
const mouths = [
  "M19 32 Q24 37 29 32",
  "M19 33 L29 33",
  "M21 32 Q24 29 27 32 Q26 36 24 36 Q21 36 21 32 Z",
  "M19 32 Q22 35 25 32 Q28 35 31 32",
] as const

export function participantAvatar(personId: unknown) {
  // Person IDs are canonical, unpadded base64url SHA-256 digests (32 bytes).
  if (typeof personId !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(personId)) {
    return {
      version: 1, neutral: true, background: "#e4e1da", faceColor: "#f3f1eb",
      crown: "", face: faces[0], eyes: eyes[0], mouth: mouths[1],
    }
  }
  // FNV-1a over the full ASCII ID; Math.imul fixes 32-bit behavior across runtimes.
  let hash = 0x811c9dc5
  for (let index = 0; index < personId.length; index++) {
    hash = Math.imul(hash ^ personId.charCodeAt(index), 0x01000193) >>> 0
  }
  return {
    version: 1, neutral: false,
    background: backgroundColors[hash & 7],
    faceColor: faceColors[(hash >>> 3) % faceColors.length],
    crown: crowns[(hash >>> 8) & 3],
    face: faces[(hash >>> 10) & 3],
    eyes: eyes[(hash >>> 12) & 3],
    mouth: mouths[(hash >>> 14) & 3],
  }
}
