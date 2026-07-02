import { describe, expect, test } from "bun:test";

import { renderMarkdownDocument } from "../src/markdown-template.ts";

describe("renderMarkdownDocument", () => {
  test("replaces source name everywhere and preserves script-like markdown", () => {
    const markdown = "plain body\n\n```html\n</script>\n```\n";
    const html = renderMarkdownDocument(markdown, "notes.md");
    const payload = readMarkdownPayload(html);

    expect(html).not.toContain("%%PAGEBIN_SOURCE_NAME%%");
    expect(html).toContain("<title>notes.md</title>");
    expect(html).toContain('data-source-name="notes.md"');
    expect(payload).toBe(markdown);
  });

  test("keeps the generated page constrained for protected artifacts", () => {
    const html = renderMarkdownDocument("# Report\n", "report.md");

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("integrity=\"sha384-");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("ADD_TAGS:[\"iframe\"]");
    expect(html).not.toContain("highlightAuto");
    expect(html).toContain("MAX_LINE_NUMBER_COUNT");
    expect(html).toContain("Markdown renderer dependencies failed to load.");
    expect(html).toContain("enhanceMetadataBlocks");
    expect(html).toContain("metadata-block");
    expect(html).toContain("sameDisplayTitle");
    expect(html).toContain("propertiesPanel.hidden=!hasProperties");
  });
});

function readMarkdownPayload(html: string): string {
  const match = html.match(/<script type="application\/json" id="markdown-source"[^>]*>([\s\S]*?)<\/script>/);

  expect(typeof match?.[1]).toBe("string");

  return JSON.parse(match?.[1] ?? "\"\"") as string;
}
