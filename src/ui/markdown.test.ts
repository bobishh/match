import { describe, expect, it } from "vitest"
import { renderMarkdown, toggleMarkdownTask } from "./markdown"

describe("shared Markdown rendering", () => {
  it("renders structured content and preserves ordinary note line breaks", () => {
    const html = renderMarkdown("# Plan\n\n**Important**\nNext line\n\n- [ ] First\n- [x] Done\n\n`code`")
    expect(html).toContain("<h1>Plan</h1>")
    expect(html).toContain("<strong>Important</strong><br>")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked="checked"')
    expect(html).toContain('disabled="disabled"')
    expect(html).not.toContain('id="task-item')
    expect(html).toContain("<code>code</code>")
  })

  it("keeps untrusted HTML and executable links out of generated markup", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n\n[run](javascript:alert(1))\n\n![run](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toMatch(/<(?:img|script)\b/)
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('src="data:')
    expect(html).toContain("&lt;script&gt;")
  })

  it("renders card previews without nested interactive elements", () => {
    const html = renderMarkdown('- [ ] **First**\n- [x] Done\n\n[site](https://example.com)\n\n![photo](https://example.com/image.png)', true)
    expect(html).not.toMatch(/<(?:a|input|img)\b/)
    expect(html).toContain("☐ ")
    expect(html).toContain("☑ ")
    expect(html).toContain("<strong>First</strong>")
  })

  it("indexes editable tasks and updates only the selected source marker", () => {
    const source = "- [ ] First\n  - [x] Nested\n1. [ ] Numbered"
    const html = renderMarkdown(source, true, true)
    expect(html).toContain('data-task-index="0"')
    expect(html).toContain('data-task-index="2"')
    expect(html).not.toContain('disabled="disabled"')
    expect(toggleMarkdownTask(source, 1, false)).toBe("- [ ] First\n  - [ ] Nested\n1. [ ] Numbered")
  })

  it("keeps cached output separate for preview and interactive-task modes", () => {
    const source = "- [ ] First\n- [x] Done\n\n[site](https://example.com)"
    const full = renderMarkdown(source)
    const preview = renderMarkdown(source, true)
    const editablePreview = renderMarkdown(source, true, true)

    expect(full).toContain('type="checkbox"')
    expect(full).toContain('disabled="disabled"')
    expect(preview).toContain("☐ ")
    expect(preview).not.toContain('type="checkbox"')
    expect(editablePreview).toContain('data-task-index="0"')
    expect(editablePreview).not.toContain('disabled="disabled"')
    expect(renderMarkdown(source, true)).toBe(preview)
  })
})
