import MarkdownIt from "markdown-it"
import { tasklist } from "@mdit/plugin-tasklist"

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(tasklist, { disabled: true, label: false })

// Card previews sit inside a button: do not nest links or input controls.
const compact = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(tasklist, { disabled: true, label: false })
compact.renderer.rules.link_open = () => '<span class="markdown-link">'
compact.renderer.rules.link_close = () => "</span>"
compact.renderer.rules.checkbox_input = (tokens, index) =>
  tokens[index].attrGet("checked") ? "☑ " : "☐ "
compact.renderer.rules.image = (tokens, index) => compact.utils.escapeHtml(tokens[index].content)

// Plugin checkbox IDs restart per render; disabled, unlabelled controls need none.
markdown.renderer.rules.checkbox_input = (tokens, index, options, _env, renderer) => {
  tokens[index].attrs = tokens[index].attrs?.filter(([name]) => name !== "id") ?? null
  return renderer.renderToken(tokens, index, options)
}

export function renderMarkdown(source: string, preview = false): string {
  return (preview ? compact : markdown).render(source)
}
