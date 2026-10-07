export const AVATAR_SIZE = 128
const AVATAR_MAX_BYTES = 16 * 1024
const AVATAR_MAX_DATA_URL_LENGTH = 22_000
export const AVATAR_MAX_SOURCE_BYTES = 8 * 1024 * 1024
export const AVATAR_MAX_SOURCE_PIXELS = 20_000_000
const AVATAR_MAX_SOURCE_EDGE = 8_192
export const AVATAR_MAX_ZOOM = 4

export type AvatarCropRect = { x: number; y: number; size: number }

export function avatarCropRect(width: number, height: number, zoom = 1, centerX = width / 2, centerY = height / 2): AvatarCropRect {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Photo must have positive image dimensions")
  }
  const safeZoom = Number.isFinite(zoom) ? clamp(zoom, 1, AVATAR_MAX_ZOOM) : 1
  const size = Math.min(width, height) / safeZoom
  const x = clamp(centerX - size / 2, 0, width - size)
  const y = clamp(centerY - size / 2, 0, height - size)
  return { x, y, size }
}

export async function encodeAvatarCrop(image: HTMLImageElement, crop: AvatarCropRect): Promise<string> {
  const width = image.naturalWidth
  const height = image.naturalHeight
  validateImageSize(width, height)
  const canvas = document.createElement("canvas")
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const context = canvas.getContext("2d", { alpha: false })
  if (!context) throw new Error("Photo crop is unavailable in this browser")
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE)

  for (const format of ["image/webp", "image/jpeg"] as const) {
    const qualities = format === "image/webp" ? [0.86, 0.74, 0.62, 0.5, 0.38, 0.28, 0.18] : [0.82, 0.68, 0.54, 0.42, 0.3, 0.2, 0.12]
    for (const quality of qualities) {
      let blob: Blob
      try { blob = await canvasBlob(canvas, format, quality) } catch { continue }
      if (blob.type !== format || blob.size > AVATAR_MAX_BYTES) continue
      const dataUrl = await blobDataUrl(blob)
      if (dataUrl.length <= AVATAR_MAX_DATA_URL_LENGTH) return dataUrl
    }
  }
  throw new Error("Photo crop exceeds the 16 KiB avatar limit")
}

export function validateImageSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Photo must have positive image dimensions")
  }
  if (width > AVATAR_MAX_SOURCE_EDGE || height > AVATAR_MAX_SOURCE_EDGE || width * height > AVATAR_MAX_SOURCE_PIXELS) {
    throw new Error("Photo dimensions are too large to crop")
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Photo crop could not be encoded")), type, quality)
  })
}

function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Photo crop could not be read"))
    reader.onerror = () => reject(reader.error ?? new Error("Photo crop could not be read"))
    reader.readAsDataURL(blob)
  })
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}
