export type ArchiveColumnLike = {
  archive?: true
  displayHint?: "normal" | "collapsed"
}

export function isArchiveColumn(column: ArchiveColumnLike): boolean {
  return column.archive === true || (column.archive === undefined && column.displayHint === "collapsed")
}

export function setArchiveColumn(column: ArchiveColumnLike, archive: boolean): void {
  if (archive) column.archive = true
  else delete column.archive
  column.displayHint = archive ? "collapsed" : "normal"
}
