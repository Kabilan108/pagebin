---
title: Edge Case Notes
summary: Nested properties, arrays, inline HTML, footnotes, and long table content.
labels:
  - alpha
  - beta
  - gamma
links:
  docs:
    owners:
      - platform
      - docs
---

# Edge Case Notes

Inline HTML should survive when safe: <kbd>Ctrl</kbd> + <kbd>K</kbd>.

## Long Table

| Column | Content |
| --- | --- |
| Long text | This row intentionally contains a longer generated sentence so the table has to preserve useful columns without collapsing the page layout. |
| Inline code | `pagebin publish ./artifact.md --ttl 7d` |

## Footnote

Generated reports sometimes include footnotes.[^agent]

[^agent]: Footnotes should render at the bottom with a backlink.

## Unknown Code

```madeup
this should still render as a code block
with line numbers
```
