# Trapper Voice design notes

Trapper Voice is part of the Trapper ecosystem and follows **Trapper's `design.md` without changes**. `src/styles/tokens.css` is a verbatim copy of Trapper's token file; if a shared value changes, change it in Trapper and copy it here. Do not add a second palette.

Voice-specific decisions, all built from existing tokens:

1. **Record screen = the Today timer card.** Same card, label, tabular `00:00:00` display and quiet copy. The primary control is larger (88 px) because it is the whole point of the app and is used one-handed.
2. **State is never colour alone.** Recording is a square Stop glyph plus a warm focus-coloured ring (`--color-focus`) plus the label "Recording"; a mark counter and text status sit under the controls. Upload status is always an icon plus words ("Uploaded", "Will retry in 40s", "Needs attention").
3. **Neutral language.** A failed upload says what happened and what will happen next, never blames the person or the connection.
4. **Success uses the soft green Trapper Money uses for income** (`#b9d3b0`), with a check icon and the word "Uploaded". Errors use `--color-error`.
5. **Library list = Week accordion.** Rows expand in place; day headings use the Today day wording ("Today", "Yesterday").
6. **Destructive actions are reversible**: delete shows an Undo toast (7 s), as in Money.
7. **Reduced motion**: the record pulse and spinner stop, and the level meter updates at 4 Hz.
8. **Narrow screens**: navigation pills span the width at 680 px and below, as in Trapper; no horizontal scrolling at 320 px (checked by `npm run test:e2e`).
