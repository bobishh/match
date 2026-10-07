const MAX_AVATAR_BYTES = 16 * 1024
export const MAX_AVATAR_DATA_URL_LENGTH = 22_000
export const memberProfileEntityId = (personId: string) => `member-profile:${personId}`

const avatarDataUrl = /^data:image\/(?:webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/

export function isAvatarDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_AVATAR_DATA_URL_LENGTH) return false
  const match = avatarDataUrl.exec(value)
  if (!match) return false
  const encoded = match[1]!
  if (encoded.length % 4 !== 0) return false
  if (Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) > MAX_AVATAR_BYTES) return false
  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return avatarDimensions(bytes, value.startsWith("data:image/webp"))
  } catch { return false }
}

function avatarDimensions(bytes: Uint8Array, webp: boolean): boolean {
  if (webp) return webpDimensions(bytes)
  return jpegDimensions(bytes)
}

function webpDimensions(bytes: Uint8Array): boolean {
  if (bytes.length < 30 || textAt(bytes, 0, "RIFF") === false || textAt(bytes, 8, "WEBP") === false) return false
  return (textAt(bytes, 12, "VP8X") && webpExtended128(bytes)) ||
    (textAt(bytes, 12, "VP8 ") && webpLossy128(bytes)) ||
    (textAt(bytes, 12, "VP8L") && webpLossless128(bytes))
}

function webpExtended128(bytes: Uint8Array): boolean {
  return bytes[24] === 127 && bytes[25] === 0 && bytes[26] === 0 && bytes[27] === 127 && bytes[28] === 0 && bytes[29] === 0
}

function webpLossy128(bytes: Uint8Array): boolean {
  return bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a &&
    ((bytes[26]! | (bytes[27]! << 8)) & 0x3fff) === 128 && ((bytes[28]! | (bytes[29]! << 8)) & 0x3fff) === 128
}

function webpLossless128(bytes: Uint8Array): boolean {
  if (bytes.length < 25 || bytes[20] !== 0x2f) return false
  const width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8)
  const height = 1 + ((bytes[22]! & 0xc0) >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10)
  return width === 128 && height === 128
}

function jpegDimensions(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return false
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.length) return false
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!
      return width === 128 && height === 128
    }
    offset += length
  }
  return false
}

function textAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

export function isMemberProfileData(value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_AVATAR_DATA_URL_LENGTH + 100) return false
  try {
    const record = JSON.parse(value) as Record<string, unknown>
    return Object.keys(record).length === 2 && isAvatarDataUrl(record.avatarData) &&
      typeof record.changedAt === "string" && Number.isFinite(Date.parse(record.changedAt)) &&
      new Date(record.changedAt).toISOString() === record.changedAt
  } catch { return false }
}

export function memberAvatarData(value: unknown): string | undefined {
  if (typeof value !== "string" || !isMemberProfileData(value)) return undefined
  return (JSON.parse(value) as { avatarData: string }).avatarData
}
