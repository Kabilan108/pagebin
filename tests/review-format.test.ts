import { describe, expect, test } from "bun:test";

import {
  formatReviewMarkdown,
  type ReviewCommentView,
  type ReviewDecisionView,
  type ReviewFormatInput,
} from "../shared/review";

const artifact = { id: "k7m2q9", title: "Per-artifact origins", filename: "plan.html", version: 2 };

const decision = (overrides: Partial<ReviewDecisionView>): ReviewDecisionView => ({
  id: "retry-policy",
  question: "Should a failed send retry on its own?",
  controls: [
    {
      name: "retry-policy",
      type: "radio",
      default: "3x",
      options: [
        { value: "3x", label: "Yes, 3 times" },
        { value: "no", label: "No" },
      ],
    },
    { name: "retry-policy:note", type: "textarea", default: "" },
  ],
  values: { "retry-policy": "3x", "retry-policy:note": "" },
  interacted: false,
  answeredVersion: 2,
  updatedAt: "2026-10-06T00:00:00.000Z",
  orphaned: false,
  notOffered: false,
  ...overrides,
});

const comment = (overrides: Partial<ReviewCommentView>): ReviewCommentView => ({
  id: "c1",
  anchor: { quote: 'Cancel wins  if it "lands"', prefix: "", suffix: "", version: 2 },
  body: "what does the user see\nwhen it is too late?",
  status: "open",
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  found: true,
  ...overrides,
});

const viewerInput: ReviewFormatInput = {
  artifact,
  listsUnanswered: true,
  decisions: [
    decision({
      values: { "retry-policy": "no", "retry-policy:note": "users retry by hand" },
      interacted: true,
    }),
    decision({
      id: "limit",
      controls: [{ name: "limit", type: "select", default: "50" }],
      values: { limit: "50" },
    }),
    decision({
      id: "gates",
      controls: [{ name: "gates", type: "checkbox", default: ["a", "b"] }],
      values: { gates: ["b", "a"] },
      interacted: true,
      answeredVersion: 1,
      orphaned: true,
    }),
  ],
  comments: [
    comment({}),
    comment({ id: "c2", status: "addressed" }),
    comment({
      id: "c3",
      found: false,
      anchor: { quote: "gone", prefix: "", suffix: "", version: 1 },
    }),
  ],
};

describe("formatReviewMarkdown", () => {
  test("formats the viewer's copy response", () => {
    expect(formatReviewMarkdown(viewerInput)).toBe(
      [
        "## Review: Per-artifact origins (plan.html, v2)",
        "2 of 3 decisions answered · 1 comment · PageBin k7m2q9",
        "",
        "## Decisions",
        '- retry-policy → no (changed; default 3x)  note: "users retry by hand"',
        "- limit → 50 (untouched; default)",
        "- gates → b, a (kept; default; answered on v1, absent in v2)",
        "",
        "## Comments",
        '- > "Cancel wins if it \\"lands\\""',
        "  what does the user see",
        "  when it is too late?",
        "",
        "_1 addressed comment and 1 comment on text no longer in v2 omitted._",
        "",
      ].join("\n"),
    );
  });

  test("formats the CLI view without document knowledge", () => {
    const output = formatReviewMarkdown({
      artifact,
      listsUnanswered: false,
      decisions: [
        decision({
          values: { "retry-policy": "3x", "retry-policy:note": "" },
          interacted: true,
          answeredVersion: 1,
        }),
      ],
      comments: [
        comment({ found: null, anchor: { quote: "old text", prefix: "", suffix: "", version: 1 } }),
      ],
    });

    expect(output).toBe(
      [
        "## Review: Per-artifact origins (plan.html, v2)",
        "1 decision answered · 1 comment · PageBin k7m2q9",
        "",
        "## Decisions",
        "- retry-policy → 3x (kept; default; answered on v1)",
        "_Decisions without an answer are not listed; treat them as unconfirmed._",
        "",
        "## Comments",
        '- > "old text"',
        "  _(on v1)_",
        "  what does the user see",
        "  when it is too late?",
        "",
      ].join("\n"),
    );
  });

  test("survives being embedded through its source text", () => {
    const embedded = new Function(
      `return ${formatReviewMarkdown.toString()}`,
    )() as typeof formatReviewMarkdown;

    expect(embedded(viewerInput)).toBe(formatReviewMarkdown(viewerInput));
  });
});
