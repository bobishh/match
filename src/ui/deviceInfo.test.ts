import { describe, expect, it } from "vitest"
import { describeUserAgent } from "./deviceInfo"

describe("device user-agent description", () => {
  it("Given a reported Chrome UA, when described, then browser and OS are explicitly best-effort", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36")).toBe("Likely Chrome · macOS")
  })

  it("Given no usable UA, when described, then the UI reports unknown rather than guessing", () => {
    expect(describeUserAgent()).toBe("Browser / OS unknown")
    expect(describeUserAgent("MatchDevice/1.0")).toBe("Browser / OS unknown")
  })
})
