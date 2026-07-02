---
title: Agent Report
description: A compact generated report with frontmatter, a table, Mermaid, and code.
owner: codex
tags:
  - pagebin
  - markdown
review:
  owner: docs
  cadence: weekly
---

# Agent Report

This fixture represents the kind of Markdown artifact an agent might produce while working.

> **Note:** The renderer should show frontmatter as properties and keep this body focused on the report.

## Checklist

- [x] Render GitHub-flavored Markdown
- [x] Highlight code blocks
- [x] Render Mermaid diagrams
- [ ] Publish the final integration

| Area | Expected behavior | Status |
| --- | --- | --- |
| Frontmatter | Rendered as properties | Ready |
| Tables | Scroll without breaking columns | Ready |
| Code | Line numbers and copy button | Ready |

## Flow

```mermaid
flowchart LR
  A[Markdown] --> B[pagebin CLI]
  B --> C[HTML template]
  C --> D[Worker upload]
```

## Code

```ts
interface Artifact {
  filename: string;
  html: string;
}
```
