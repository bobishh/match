import {
  type EntityId,
  type Rank,
  type WorkspaceEntity,
  type ProjectionIssue,
  validatePlacementParent,
} from "./model"

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

export function parseRank(rank: string): [bigint, bigint] {
  const parts = rank.split("/")
  if (parts.length !== 2) throw new Error(`Invalid rank: ${rank}`)
  const num = BigInt(parts[0])
  const den = BigInt(parts[1])
  if (den <= 0n) throw new Error(`Invalid denominator in rank: ${rank}`)
  return [num, den]
}

export function reduceRational(num: bigint, den: bigint): string {
  if (den < 0n) {
    num = -num
    den = -den
  }
  if (num === 0n) return "0/1"
  const g = gcdBigInt(num, den)
  return `${num / g}/${den / g}`
}

export function compareRanks(r1: string, r2: string): number {
  const [n1, d1] = parseRank(r1)
  const [n2, d2] = parseRank(r2)
  const diff = n1 * d2 - n2 * d1
  if (diff < 0n) return -1
  if (diff > 0n) return 1
  return 0
}

export function calculateRankBetween(prevRank: string | null, nextRank: string | null): string {
  if (prevRank === null && nextRank === null) {
    return "0/1"
  }
  if (prevRank === null) {
    const [n, d] = parseRank(nextRank!)
    return reduceRational(n - d, d)
  }
  if (nextRank === null) {
    const [n, d] = parseRank(prevRank!)
    return reduceRational(n + d, d)
  }

  const [n1, d1] = parseRank(prevRank)
  const [n2, d2] = parseRank(nextRank)

  // Mediant of n1/d1 and n2/d2 is (n1 + n2) / (d1 + d2)
  const num = n1 + n2
  const den = d1 + d2
  return reduceRational(num, den)
}

export function sortEntitiesByRank<T extends { id: string; placement: { rank: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const cmp = compareRanks(a.placement.rank, b.placement.rank)
    if (cmp !== 0) return cmp
    // Tie-break by ASCII ID comparison
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export function renumberSiblings<T extends { id: string; placement: { rank: string; parentId: string | null } }>(
  items: T[]
): T[] {
  const sorted = sortEntitiesByRank(items)
  return sorted.map((item, index) => ({
    ...item,
    placement: {
      ...item.placement,
      rank: `${index}/1`,
    },
  }))
}

export function getChildren(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null
): WorkspaceEntity[] {
  const children: WorkspaceEntity[] = []
  for (const entity of Object.values(entities)) {
    if (entity.placement.parentId === parentId) {
      children.push(entity)
    }
  }
  return sortEntitiesByRank(children)
}

export function getAncestryPath(
  entities: Record<string, WorkspaceEntity>,
  entityId: string
): { path: string[]; issue?: ProjectionIssue } {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId: string | null = entityId

  const maxSteps = Object.keys(entities).length + 2
  let steps = 0

  while (currentId !== null) {
    steps++
    if (steps > maxSteps || visited.has(currentId)) {
      // Cycle detected
      return {
        path,
        issue: {
          type: "cycle",
          entityId,
          cycleIds: Array.from(visited),
        },
      }
    }

    visited.add(currentId)
    const entity: WorkspaceEntity | undefined = entities[currentId]
    if (!entity) {
      return {
        path,
        issue: {
          type: "missing-parent",
          entityId,
          parentId: currentId,
        },
      }
    }

    path.push(currentId)
    const parentId: string | null = entity.placement.parentId
    if (parentId !== null) {
      const parent = entities[parentId]
      if (!parent) {
        return {
          path,
          issue: {
            type: "missing-parent",
            entityId,
            parentId,
          },
        }
      }
      const validParent = validatePlacementParent(entity.kind, parent.kind)
      if (!validParent.ok) {
        return {
          path,
          issue: {
            type: "invalid-parent-kind",
            entityId,
            parentId,
          },
        }
      }
    } else {
      const validRoot = validatePlacementParent(entity.kind, null)
      if (!validRoot.ok) {
        return {
          path,
          issue: {
            type: "invalid-parent-kind",
            entityId,
            parentId: null,
          },
        }
      }
    }

    currentId = parentId
  }

  return { path }
}

export function derivePlacementIssues(entities: Record<string, WorkspaceEntity>): ProjectionIssue[] {
  const issues: ProjectionIssue[] = []
  for (const entity of Object.values(entities)) {
    const { issue } = getAncestryPath(entities, entity.id)
    if (issue) {
      issues.push(issue)
    }
  }
  return issues
}

export function isEntityVisible(
  entities: Record<string, WorkspaceEntity>,
  entityId: string,
  workspaceDeleted = false
): boolean {
  if (workspaceDeleted) return false
  const entity = entities[entityId]
  if (!entity || entity.deleted) return false

  const { issue } = getAncestryPath(entities, entityId)
  if (issue) return false

  // Verify no ancestor is deleted
  let curr: WorkspaceEntity | undefined = entity
  while (curr && curr.placement.parentId !== null) {
    curr = entities[curr.placement.parentId]
    if (!curr || curr.deleted) return false
  }

  return true
}

export function getVisibleChildren(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null,
  workspaceDeleted = false
): WorkspaceEntity[] {
  const children = getChildren(entities, parentId)
  return children.filter((child) => isEntityVisible(entities, child.id, workspaceDeleted))
}
