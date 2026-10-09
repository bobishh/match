import type { WorkspaceRole } from "../domain/permissions"

export const canRoles: Record<WorkspaceRole, { body: string; highlight: string; shade: string; stamp: string }> = {
  owner: { body: "#d5b16d", highlight: "#ebd3a4", shade: "#a78245", stamp: "M12 0 15 8 24 9 17 15 19 24 12 19 5 24 7 15 0 9 9 8Z" },
  editor: { body: "#80b9d8", highlight: "#b5d9ec", shade: "#548ba9", stamp: "M9 2h6v7h7v6h-7v7H9v-7H2V9h7Z" },
  visitor: { body: "#c8c9cb", highlight: "#e4e5e6", shade: "#a8a9ac", stamp: "M2 9h20v6H2Z" },
  automation: { body: "#b8a4d6", highlight: "#d7c9eb", shade: "#8d76ad", stamp: "M12 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 11h16v3H4Zm2 5h12v3H6Z" },
}
