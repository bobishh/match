export function describeUserAgent(userAgent?: string): string {
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
