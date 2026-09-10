function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

export function isValidRank(rank: string): boolean {
  if (typeof rank !== "string") return false
  const match = rank.match(/^(-?\d+)\/(\d+)$/)
  if (!match) return false
  const numStr = match[1]
  const denStr = match[2]
  try {
    const num = BigInt(numStr)
    const den = BigInt(denStr)
    if (den <= 0n) return false
    // must be reduced: gcd(|num|, den) === 1
    if (num === 0n) {
      return den === 1n
    }
    return gcdBigInt(num, den) === 1n
  } catch {
    return false
  }
}

