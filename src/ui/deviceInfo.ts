export function describeUserAgent(userAgent?: string): string {
  if (!userAgent?.trim()) return "Browser / OS unknown"

  const os = /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
    : /Android/.test(userAgent) ? "Android"
      : /Windows NT/.test(userAgent) ? "Windows"
        : /CrOS/.test(userAgent) ? "ChromeOS"
          : /Macintosh|Mac OS X/.test(userAgent) ? "macOS"
            : /Linux/.test(userAgent) ? "Linux"
              : ""

  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /OPR\//.test(userAgent) ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent) ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
          : /Safari\//.test(userAgent) && /Version\//.test(userAgent) ? "Safari"
            : ""

  return browser && os ? `Likely ${browser} · ${os}` : "Browser / OS unknown"
}
