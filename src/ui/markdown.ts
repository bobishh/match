import MarkdownIt from "markdown-it"
import type { Env } from "markdown-it"
import { tasklist } from "@mdit/plugin-tasklist"

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(tasklist, { disabled: false, label: false })

// Card previews sit inside a button: do not nest links or input controls.
const compact = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(tasklist, { disabled: false, label: false })
compact.renderer.rules.link_open = () => '<span class="markdown-link">'
compact.renderer.rules.link_close = () => "</span>"
compact.renderer.rules.image = (tokens, index) => compact.utils.escapeHtml(tokens[index].content)

type MarkdownEnvironment = { interactiveTasks?: boolean; taskIndex?: number }

function renderCheckbox(tokens: Parameters<NonNullable<typeof markdown.renderer.rules.checkbox_input>>[0], index: number, options: Parameters<NonNullable<typeof markdown.renderer.rules.checkbox_input>>[2], env: Env | undefined, renderer: Parameters<NonNullable<typeof markdown.renderer.rules.checkbox_input>>[4]) {
  const token = tokens[index]
  const taskEnv = (env ?? {}) as MarkdownEnvironment
  const taskIndex = taskEnv.taskIndex ?? 0
  taskEnv.taskIndex = taskIndex + 1
  token.attrs = token.attrs?.filter(([name]) => name !== "id" && name !== "disabled" && name !== "data-task-index") ?? []
  token.attrPush(["data-task-index", String(taskIndex)])
  if (!taskEnv.interactiveTasks) token.attrPush(["disabled", "disabled"])
  return renderer.renderToken(tokens, index, options)
}

markdown.renderer.rules.checkbox_input = renderCheckbox
compact.renderer.rules.checkbox_input = (tokens, index, options, env, renderer) =>
  (env as MarkdownEnvironment | undefined)?.interactiveTasks
    ? renderCheckbox(tokens, index, options, env, renderer)
    : tokens[index].attrGet("checked") ? "☑ " : "☐ "

export function renderMarkdown(source: string, preview = false, interactiveTasks = false): string {
  return (preview ? compact : markdown).render(source, { interactiveTasks, taskIndex: 0 })
}

export function toggleMarkdownTask(source: string, taskIndex: number, checked: boolean): string {
  let current = 0
  return source.replace(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/gm, (match, prefix: string, _marker: string, suffix: string) => {
    if (current++ !== taskIndex) return match
    return `${prefix}${checked ? "x" : " "}${suffix}`
  })
}
