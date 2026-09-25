export function isLighthouse(userAgent?: string): boolean {
  return /^mesh-lighthouse\/\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(userAgent ?? "")
}

export function describeUserAgent(userAgent?: string): string {
  if (isLighthouse(userAgent)) return "Lighthouse"
  if (!userAgent?.trim()) return "Browser / OS unknown"
  const os = identifyUserAgent(userAgent, [
    [/iPhone|iPad|iPod/, "iOS"], [/Android/, "Android"], [/Windows NT/, "Windows"],
    [/CrOS/, "ChromeOS"], [/Macintosh|Mac OS X/, "macOS"], [/Linux/, "Linux"],
  ])
  const browser = identifyUserAgent(userAgent, [
    [/Edg\//, "Edge"], [/OPR\//, "Opera"], [/Firefox\/|FxiOS\//, "Firefox"],
    [/Chrome\/|CriOS\//, "Chrome"], [/Safari\/.*Version\/|Version\/.*Safari\//, "Safari"],
  ])

  return browser && os ? `Likely ${browser} · ${os}` : "Browser / OS unknown"
}

function identifyUserAgent(userAgent: string, signatures: Array<[RegExp, string]>): string {
  return signatures.find(([signature]) => signature.test(userAgent))?.[1] ?? ""
}

export type MeshMemberView = {
    personId: string
    name: string
    role: "owner" | "editor" | "visitor"
    online: boolean
    reconnecting: boolean
    onlineDevices: number
    devices: number
    self: boolean
    deviceList: Array<{
      deviceId: string
      name: string
      online: boolean
      reconnecting: boolean
      lastSeen: string
      userAgent?: string
      description: string
      tabs: number
    }>
  }
