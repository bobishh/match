import { afterEach, describe, expect, it, vi } from "vitest"
import { avatarCropRect, AVATAR_MAX_ZOOM, AVATAR_MAX_SOURCE_PIXELS, encodeAvatarCrop, validateImageSize } from "./avatarCrop"

class TestFileReader {
  result: string | ArrayBuffer | null = null
  error: DOMException | null = null
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null

  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(bytes => {
      const binary = Array.from(new Uint8Array(bytes), value => String.fromCharCode(value)).join("")
      this.result = `data:${blob.type};base64,${btoa(binary)}`
      this.onload?.(new Event("load") as ProgressEvent<FileReader>)
    })
  }
}

function canvasHarness(encode: (type: string, quality: number) => Blob | null) {
  const calls: Array<{ type: string; quality: number }> = []
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback, type: string, quality: number) => {
      calls.push({ type, quality })
      callback(encode(type, quality))
    }),
  }
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) })
  vi.stubGlobal("FileReader", TestFileReader)
  const image = { naturalWidth: 512, naturalHeight: 256 } as HTMLImageElement
  return { calls, canvas, context, image }
}

afterEach(() => vi.unstubAllGlobals())

describe("avatar crop geometry", () => {
  it("centers a square crop over a non-square photo", () => {
    expect(avatarCropRect(400, 200)).toEqual({ x: 100, y: 0, size: 200 })
    expect(avatarCropRect(200, 400)).toEqual({ x: 0, y: 100, size: 200 })
  })

  it("zooms around the requested center and clamps crop to source bounds", () => {
    expect(avatarCropRect(400, 200, 2)).toEqual({ x: 150, y: 50, size: 100 })
    expect(avatarCropRect(400, 200, 2, 400, 100)).toEqual({ x: 300, y: 50, size: 100 })
    expect(avatarCropRect(400, 200, 2, 0, 100)).toEqual({ x: 0, y: 50, size: 100 })
  })

  it("clamps zoom to its supported range", () => {
    expect(avatarCropRect(400, 200, 0).size).toBe(200)
    expect(avatarCropRect(400, 200, 100).size).toBe(200 / AVATAR_MAX_ZOOM)
  })

  it("rejects empty, invalid, and oversized decoded images", () => {
    expect(() => avatarCropRect(0, 200)).toThrow(/positive image dimensions/i)
    expect(() => validateImageSize(Number.NaN, 200)).toThrow(/positive image dimensions/i)
    expect(() => validateImageSize(Math.ceil(AVATAR_MAX_SOURCE_PIXELS / 100), 100)).toThrow(/too large/i)
  })

  it("encodes a 128-pixel WebP crop at the first supported quality", async () => {
    const { calls, canvas, context, image } = canvasHarness(type => new Blob([new Uint8Array([1, 2, 3])], { type }))
    const result = await encodeAvatarCrop(image, { x: 80, y: 0, size: 256 })

    expect(result).toMatch(/^data:image\/webp;base64,/)
    expect(canvas.width).toBe(128)
    expect(canvas.height).toBe(128)
    expect(context.drawImage).toHaveBeenCalledWith(image, 80, 0, 256, 256, 0, 0, 128, 128)
    expect(context.imageSmoothingEnabled).toBe(true)
    expect(calls).toEqual([{ type: "image/webp", quality: 0.86 }])
  })

  it("falls back from unsupported WebP and oversized quality candidates to bounded JPEG", async () => {
    const { calls } = canvasHarness((type, quality) => {
      if (type === "image/webp" || quality > 0.2) return new Blob([new Uint8Array(16 * 1024 + 1)], { type })
      return new Blob([new Uint8Array([1, 2, 3])], { type })
    })

    const result = await encodeAvatarCrop({ naturalWidth: 256, naturalHeight: 256 } as HTMLImageElement, { x: 0, y: 0, size: 256 })

    expect(result).toMatch(/^data:image\/jpeg;base64,/)
    expect(calls.at(-1)).toEqual({ type: "image/jpeg", quality: 0.2 })
    expect(calls.some(call => call.type === "image/jpeg")).toBe(true)
  })

  it("rejects encoding when canvas context is unavailable", async () => {
    const harness = canvasHarness(type => new Blob([new Uint8Array([1])], { type }))
    vi.mocked(harness.canvas.getContext).mockReturnValueOnce(null as never)
    await expect(encodeAvatarCrop(harness.image, { x: 0, y: 0, size: 256 })).rejects.toThrow(/unavailable in this browser/i)
  })

  it("rejects images when no supported encoding fits the avatar limit", async () => {
    canvasHarness(type => type === "image/webp" ? null : new Blob([new Uint8Array(16 * 1024 + 1)], { type }))
    await expect(encodeAvatarCrop({ naturalWidth: 128, naturalHeight: 128 } as HTMLImageElement, { x: 0, y: 0, size: 128 }))
      .rejects.toThrow(/16 KiB avatar limit/i)
  })
})
