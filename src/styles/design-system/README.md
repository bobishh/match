# tincanban shared design system

Match and Rusty import `index.css` in full. tincanban owns these modules; Rusty consumes a pinned tincanban revision. Do not copy styles into consumers. Font overrides are the only local styling exception for Rusty.

- `tokens.css`: palette, spacing and sizes.
- `reset.css`: box sizing, viewport bounds and reduced-motion behavior.
- `typography.css`: Original tincanban typography: Caveat for content, controls and headings; Fira Code for technical text. Rusty sets its font overrides in its own typography.css.
- `controls.css`: shared buttons and fields.
- `layout.css`: shared shell, forms and dialogs, including native dialog backdrop.
- `chrome.css`: header and responsive chrome.
- `keeper.css`: shared keeper presentation, navigation and list hooks, scoped to `.keeper-admin`.
- `icons.css`: shared Rusty mark sizing.
- `/assets/primitive.css`: nine-slice hand-drawn frames, fills and focus contours for shared surfaces and controls.

Application styles describe their own content structure. Reuse shared classes for controls and surface appearance. Verify real routes at desktop and mobile widths, including a failure or pending state.
