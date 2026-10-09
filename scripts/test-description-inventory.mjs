import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import ts from "typescript"

const roots = ["e2e", "src", "workers", "crates", "vendor/meta-mesh/packages", "vendor/meta-mesh/crates"]
const files = execFileSync("rg", ["--files", ...roots], { encoding: "utf8" }).trim().split("\n").sort()
const rows = []
const clean = value => String(value).replace(/[\t\r\n]+/g, " ")

function titleOf(node, source) {
  if (!node) return ""
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.getText(source).slice(1, -1)
  return ""
}

function callKind(expression) {
  if (ts.isIdentifier(expression)) return { base: expression.text, modifiers: [] }
  if (ts.isPropertyAccessExpression(expression)) {
    const kind = callKind(expression.expression)
    return { ...kind, modifiers: [...kind.modifiers, expression.name.text] }
  }
  if (ts.isCallExpression(expression)) return callKind(expression.expression)
  return { base: "", modifiers: [] }
}

function inventoryTypeScript(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const layer = file.startsWith("e2e/") ? "browser" : file.startsWith("vendor/") ? "meta-mesh-unit" : file.startsWith("workers/") ? "worker-unit" : "app-unit"
  function visit(node, scope = [], loop = false) {
    const insideLoop = loop || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
    let childScope = scope
    if (ts.isCallExpression(node)) {
      const kind = callKind(node.expression)
      const title = titleOf(node.arguments[0], ast)
      const callback = node.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      const describe = kind.base === "describe" || (kind.base === "test" && kind.modifiers.includes("describe"))
      if (title && callback && describe) childScope = [...scope, title]
      else if (title && callback && ["test", "it"].includes(kind.base) && kind.modifiers.every(modifier => ["each", "skip", "only", "fixme", "concurrent", "sequential", "fails", "skipIf", "runIf"].includes(modifier))) {
        rows.push([layer, file, ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          kind.modifiers.includes("each") || insideLoop || ts.isTemplateExpression(node.arguments[0]) ? "yes" : "no", scope.join(" > "), title])
      }
    }
    ts.forEachChild(node, child => visit(child, childScope, insideLoop))
  }
  visit(ast)
}

for (const file of files) {
  const source = readFileSync(file, "utf8")
  if (/\.(?:test|spec)\.ts$/.test(file)) inventoryTypeScript(file, source)
  else if (file.endsWith(".rs")) {
    // Rust uses function identifiers rather than prose descriptions.
    for (const match of source.matchAll(/#\[(?:test|tokio::test|wasm_bindgen_test)(?:\([^\]]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)) {
      rows.push([file.startsWith("vendor/") ? "meta-mesh-rust" : "app-rust", file, source.slice(0, match.index).split("\n").length, "no", "", match[1]])
    }
  }
}

console.log(["layer", "file", "line", "parameterized", "scope", "description"].join("\t"))
for (const row of rows) console.log(row.map(clean).join("\t"))
const counts = Object.groupBy(rows, row => row[0])
console.error(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([layer, entries]) => [layer, { declarations: entries.length, files: new Set(entries.map(row => row[1])).size }]))))
