import { describe, expect, test } from "bun:test";

import { renderMarkdownArtifact, renderMarkdownDocument } from "../src/markdown-renderer.ts";

describe("renderMarkdownDocument", () => {
  test("renders meaningful static HTML without browser renderer dependencies", () => {
    const html = renderMarkdownDocument("# Report\n\nA **complete** report.\n", "report.md");

    expect(html).toContain("<title>Report</title>");
    expect(html).toContain('<h1 id="report">');
    expect(html).toContain("A <strong>complete</strong> report.");
    expect(html).not.toContain("markdown-source");
    expect(html).not.toContain("marked@");
    expect(html).not.toContain("js-yaml");
    expect(html).not.toContain("DOMPurify");
    expect(html).not.toContain("highlight.min.js");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("cdnjs.cloudflare.com");
  });

  test("renders frontmatter, metadata, outlines, and unique heading anchors", () => {
    const html = renderMarkdownDocument(`---
title: Release notes
description: What changed
owner: PageBin
tags:
  - cli
  - worker
---
# Release notes

Project: pagebin
Branch: main

## Details
## Details
`, "release.md");

    expect(html).toContain("What changed");
    expect(html).toContain('<div class="meta-key">owner</div>');
    expect(html).toContain('<li class="meta-token">cli</li>');
    expect(html).toContain('<div class="metadata-line">Project: pagebin</div>');
    expect(html).toContain('href="#details" class="depth-2">Details</a>');
    expect(html).toContain('href="#details-2" class="depth-2">Details</a>');
    expect(html).toContain('<h2 id="details">');
    expect(html).toContain('<h2 id="details-2">');
  });

  test("pre-renders code highlighting, line numbers, task lists, tables, and footnotes", () => {
    const html = renderMarkdownDocument(`# Features

- [x] shipped

| Area | State |
| --- | --- |
| CLI | fast |

\`\`\`typescript
const value = 42;
console.log(value);
\`\`\`

Footnote[^one].

[^one]: Static output.
`, "features.md");

    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('<div class="table-frame"><div class="table-scroll"><table>');
    expect(html).toContain('class="hljs language-typescript"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<pre class="line-numbers" aria-hidden="true">1\n2</pre>');
    expect(html).toContain('class="footnotes"');
    expect(html).toContain("Static output.");
  });

  test("emits the pinned Mermaid runtime only for Mermaid documents", () => {
    const markdown = `# Diagram

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`;
    const { hasMermaid, html } = renderMarkdownArtifact(markdown, "diagram.md");

    expect(hasMermaid).toBe(true);
    expect(html).toContain("mermaid@11.6.0/dist/mermaid.min.js");
    expect(html).toContain('integrity="sha384-');
    expect(html).toContain("window.addEventListener(\"DOMContentLoaded\",renderMermaid)");
    expect(html).not.toContain("marked@");
    expect(html).not.toContain("highlight.min.js");
  });

  test("uses parsed Mermaid blocks as the strict-sandbox source of truth", () => {
    const nested = renderMarkdownArtifact(`> \`\`\`mermaid
> flowchart LR
>   A --> B
> \`\`\`
`, "nested.md");
    const documented = renderMarkdownArtifact(`\`\`\`\`markdown
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
\`\`\`\`
`, "documented.md");

    expect(nested.hasMermaid).toBe(true);
    expect(nested.html).toContain("mermaid@11.6.0/dist/mermaid.min.js");
    expect(documented.hasMermaid).toBe(false);
    expect(documented.html).not.toContain("mermaid@11.6.0/dist/mermaid.min.js");
  });

  test("keeps raw HTML active and renders deterministically", () => {
    const markdown = "# Interactive\n\n<button onclick=\"document.title='clicked'\">Run</button>\n<script>globalThis.ready=true</script>\n";
    const first = renderMarkdownDocument(markdown, "interactive.md");
    const second = renderMarkdownDocument(markdown, "interactive.md");

    expect(first).toBe(second);
    expect(first).toContain('<button onclick="document.title=\'clicked\'">Run</button>');
    expect(first).toContain("<script>globalThis.ready=true</script>");
  });

  test("removes empty frontmatter instead of rendering it as document content", () => {
    const html = renderMarkdownDocument("---\n---\n# Empty metadata\n", "empty.md");

    expect(html).toContain('<h1 id="empty-metadata">');
    expect(html).not.toContain("<hr>");
  });
});
