# tincanban shared design system

Both tincanban and Rusty import `index.css` in full. tincanban owns these modules; Rusty consumes a pinned tincanban revision. Do not copy styles into consumers.

- `tokens.css`: palette, spacing and sizes.
- `typography.css`: Fira Code throughout; Caveat only in the brand header.
- `controls.css`: shared buttons and fields, square borders.
- `layout.css`: shared shell, forms and dialogs.
- `chrome.css`: header and responsive chrome.
- `keeper.css`: keeper administration layout, scoped to `.keeper-admin`.
- `icons.css`: shared Rusty mark sizing.

Application styles hold application-specific layout only. Shared control appearance belongs here. Verify real routes at desktop and mobile widths, including a failure or pending state.
