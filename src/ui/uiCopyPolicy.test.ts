import { readdirSync, readFileSync } from "node:fs"
import { resolve, relative } from "node:path"
import ts from "typescript"
import { compileTemplate, parse } from "vue/compiler-sfc"
import { describe, expect, it } from "vitest"

// Inspect all application copy, including errors/helpers outside Vue components.
// Identifiers, comments and protocol instance IDs are not UI copy. No component allowlist.
const forbidden = /\blegacy\b|легаси/iu

function protocolInstanceId(node: ts.Node): boolean {
  if (!ts.isStringLiteral(node) || node.text !== "legacy") return false
  const parent = node.parent
  if (ts.isParameter(parent)) return parent.name.getText() === "instanceId"
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && ts.isPropertyAccessExpression(parent.left) && parent.left.name.text === "instanceId"
    && ts.isPropertyAssignment(parent.parent) && parent.parent.name.getText() === "instanceId"
}

function diagnosticEvent(node: ts.Node): boolean {
  const parent = node.parent
  return ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
    && parent.expression.expression.getText() === "console" && parent.arguments[0] === node
}

function constantText(node: ts.Node): string | undefined {
  if (ts.isJsxText(node)) return node.text
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => `${constantText(span.expression) ?? "${value}"}${span.literal.text}`).join("")
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(node.left), right = constantText(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function scriptViolations(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: string[] = []
  function visit(node: ts.Node): void {
    const text = constantText(node)
    if (text !== undefined && forbidden.test(text) && !protocolInstanceId(node) && !diagnosticEvent(node)) {
      const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
      violations.push(`${file}:${line + 1}: ${text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return violations
}

function copyViolations(source: string, file: string): string[] {
  if (!/\.(vue|html|svg)$/u.test(file)) return scriptViolations(source, file)
  const descriptor = file.endsWith(".vue") ? parse(source, { filename: file }).descriptor : undefined
  const scripts = descriptor ? [descriptor.script, descriptor.scriptSetup, ...descriptor.styles].flatMap(block => block ? scriptViolations(block.content, file) : []) : []
  const embeddedScripts = !descriptor ? [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/giu)].flatMap(match => scriptViolations(match[1], file)) : []
  const template = (descriptor ? descriptor.template?.content : source)?.replace(/<!--[\s\S]*?-->/gu, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
  if (!template) return scripts
  const compiled = compileTemplate({ source: template, filename: file, id: "ui-copy-policy" })
  expect(compiled.errors, `Template inspection failed: ${file}`).toEqual([])
  return [...scripts, ...embeddedScripts, ...scriptViolations(compiled.code, file)]
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|[cm]?[jt]sx?|json|css|html|svg)$/u.test(path) && !/\.(test|spec|d)\.ts$/u.test(path) ? [path] : []
  })
}

describe("Application UI copy policy", () => {
  it("Given any application screen or copy helper, When source is checked, Then no legacy terminology can ship", () => {
    const root = resolve(import.meta.dirname, "../..")
    const files = [...sourceFiles(resolve(root, "src")), ...sourceFiles(resolve(root, "public")), resolve(root, "index.html")]
    const violations = files.flatMap(file => copyViolations(readFileSync(file, "utf8"), relative(root, file)))
    expect(violations, "Remove implementation terminology from application UI copy").toEqual([])
  })

  it.each([
    ['<template><p>Legacy connection</p></template>', "Screen.vue"],
    ['<template><input placeholder="LEGACY" aria-label="legacy setup" /></template>', "NewScreen.vue"],
    ['<template><button :title="\'Legacy connection\'">Open</button></template>', "NewControl.vue"],
    ['const warning = `Unsupported legacy ${kind}`', "newHelper.ts"],
    ['const label = "Legacy"', "labels.ts"],
    ['const title = "legacy-connection"', "labels.ts"],
    ['const title = peer.instanceId ?? "legacy"', "labels.ts"],
    ['throw new Error("Legacy storage failed")', "storage.ts"],
    ['const label = "Leg" + "acy"', "labels.ts"],
    ['const label = "\\u004cegacy"', "labels.ts"],
    ['<template><p>Legacy</p></template>', "Screen.vue"],
    ['<template><p>легаси</p></template>', "Screen.vue"],
    ['<svg><text>Legacy system</text></svg>', "icon.svg"],
    ['.status::after { content: "Legacy"; }', "screen.css"],
    ['<template><p>OK</p></template><style>.status::after { content: "Legacy"; }</style>', "StyledScreen.vue"],
    ['const panel = <p>Legacy system</p>', "screen.tsx"],
    ['{ "label": "Legacy connection" }', "translations.json"],
  ])("Given forbidden copy %s, When inspected, Then the policy rejects it", (source, file) => {
    expect(copyViolations(source, file)).not.toEqual([])
  })

  it("Given internal migration names, When inspected, Then comments and protocol identifiers remain allowed", () => {
    expect(copyViolations('// Legacy migration\nconst legacyKey = "__meta__legacy-journal-v1"\nconst peer = { instanceId: payload.instanceId ?? "legacy" }', "storage.ts")).toEqual([])
    expect(copyViolations('<template><!-- legacy migration --><p>Storage unavailable</p></template>', "Screen.vue")).toEqual([])
  })
})
