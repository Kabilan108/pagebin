export const REVIEW_LIMITS = {
  commentBody: 8000,
  quote: 1000,
  anchorContext: 200,
  comments: 500,
  decisions: 200,
  decisionBytes: 8 * 1024,
  recordBytes: 512 * 1024,
  requestBytes: 64 * 1024,
} as const;

export type ReviewCommentStatus = "open" | "addressed";

export interface ReviewAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  version: number;
}

export interface ReviewComment {
  id: string;
  anchor: ReviewAnchor;
  body: string;
  status: ReviewCommentStatus;
  createdAt: string;
  updatedAt: string;
  addressedAt?: string;
}

export type DecisionValue = string | string[] | null;

export type DecisionControlType = "radio" | "checkbox" | "range" | "select" | "text" | "textarea";

export interface DecisionOption {
  value: string;
  label: string;
}

export interface DecisionControl {
  name: string;
  type: DecisionControlType;
  default: DecisionValue;
  options?: DecisionOption[];
}

// One viewer page load (page) and its monotonic write counter (n). The server ignores a
// decision write from the same page with a lower n, so a delayed request cannot overwrite a
// newer answer sent with keepalive as the page closed.
export interface DecisionWrite {
  page: string;
  n: number;
}

export interface ReviewDecision {
  id: string;
  question: string;
  controls: DecisionControl[];
  values: Record<string, DecisionValue>;
  interacted: boolean;
  answeredVersion: number;
  updatedAt: string;
  lastWrite?: DecisionWrite;
}

export interface ReviewRecord {
  schemaVersion: 1;
  comments: ReviewComment[];
  decisions: ReviewDecision[];
  updatedAt: string | null;
}

export interface ReviewDecisionView extends ReviewDecision {
  orphaned: boolean;
  notOffered: boolean;
}

export interface ReviewCommentView extends ReviewComment {
  // null when the caller cannot see the document, as in the CLI.
  found: boolean | null;
}

export interface ReviewFormatInput {
  artifact: { id: string; title: string; filename: string; version: number };
  decisions: ReviewDecisionView[];
  comments: ReviewCommentView[];
  // The viewer knows every decision in the document; the CLI only sees answered ones.
  listsUnanswered: boolean;
}

// The viewer embeds this function's source in its page script, so it must not reference
// anything outside its own body.
export function formatReviewMarkdown(input: ReviewFormatInput): string {
  const plural = (count: number, word: string): string =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

  const isNote = (control: DecisionControl): boolean => control.name.endsWith(":note");

  const normalized = (value: DecisionValue | undefined): DecisionValue =>
    Array.isArray(value) ? [...value].sort() : (value ?? null);

  const sameValue = (left: DecisionValue | undefined, right: DecisionValue | undefined): boolean =>
    JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));

  const valueText = (value: DecisionValue | undefined): string => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return "none";
    }

    return Array.isArray(value) ? value.join(", ") : value;
  };

  const status = (decision: ReviewDecisionView): "changed" | "kept" | "untouched" => {
    const changed = decision.controls
      .filter((control) => !isNote(control))
      .some((control) => !sameValue(decision.values[control.name], control.default));

    if (changed) return "changed";

    return decision.interacted ? "kept" : "untouched";
  };

  const answer = (
    decision: ReviewDecisionView,
    pick: (control: DecisionControl) => DecisionValue | undefined,
  ): string => {
    const answerable = decision.controls.filter((control) => !isNote(control));

    if (answerable.length === 1 && answerable[0]) return valueText(pick(answerable[0]));

    return answerable
      .map((control) => {
        const suffix = control.name.slice(decision.id.length + 1) || control.name;

        return `${suffix}=${valueText(pick(control))}`;
      })
      .join(", ");
  };

  const note = (decision: ReviewDecisionView): string =>
    decision.controls
      .filter(isNote)
      .map((control) => {
        const value = decision.values[control.name];

        return Array.isArray(value) ? value.join(" ").trim() : (value ?? "").trim();
      })
      .filter((value) => value.length > 0)
      .join(" / ");

  const escapeQuote = (value: string): string =>
    value.replace(/\s+/g, " ").trim().replace(/"/g, '\\"');

  const { artifact } = input;
  const statuses = input.decisions.map(status);
  const answeredCount = statuses.filter((value) => value !== "untouched").length;

  const open = input.comments.filter(
    (comment) => comment.status === "open" && comment.found !== false,
  );

  const addressedCount = input.comments.filter((comment) => comment.status === "addressed").length;

  const detached = input.comments.filter(
    (comment) => comment.status === "open" && comment.found === false,
  );

  const decisionSummary = input.listsUnanswered
    ? `${answeredCount} of ${plural(input.decisions.length, "decision")} answered`
    : `${plural(answeredCount, "decision")} answered`;

  const lines = [
    `## Review: ${artifact.title} (${artifact.filename}, v${artifact.version})`,
    `${decisionSummary} · ${plural(open.length, "comment")} · PageBin ${artifact.id}`,
    "",
    "## Decisions",
  ];

  if (input.decisions.length === 0) {
    lines.push(input.listsUnanswered ? "_none in this artifact_" : "_none answered_");
  }

  input.decisions.forEach((decision, index) => {
    const decisionStatus = statuses[index] ?? "untouched";
    const details: string[] = [decisionStatus];

    details.push(
      decisionStatus === "changed"
        ? `default ${answer(decision, (control) => control.default)}`
        : "default",
    );

    if (decision.orphaned) {
      details.push(`answered on v${decision.answeredVersion}, absent in v${artifact.version}`);
    } else if (decision.notOffered) {
      details.push(`no longer offered in v${artifact.version}`);
    } else if (!input.listsUnanswered && decision.answeredVersion !== artifact.version) {
      details.push(`answered on v${decision.answeredVersion}`);
    }

    const decisionNote = note(decision);
    const noteText = decisionNote ? `  note: "${escapeQuote(decisionNote)}"` : "";

    lines.push(
      `- ${decision.id} → ${answer(decision, (control) => decision.values[control.name])} (${details.join("; ")})${noteText}`,
    );
  });

  if (!input.listsUnanswered) {
    lines.push("_Decisions without an answer are not listed; treat them as unconfirmed._");
  }

  lines.push("", "## Comments");

  if (open.length === 0) lines.push("_none_");

  for (const comment of open) {
    lines.push(`- > "${escapeQuote(comment.anchor.quote)}"`);

    if (comment.found === null && comment.anchor.version !== artifact.version) {
      lines.push(`  _(on v${comment.anchor.version})_`);
    }

    for (const line of comment.body.split("\n")) lines.push(`  ${line}`);
  }

  const omitted: string[] = [];

  if (addressedCount > 0) omitted.push(plural(addressedCount, "addressed comment"));

  if (detached.length > 0) {
    const gone = detached.every((comment) => comment.anchor.version < artifact.version)
      ? "no longer in"
      : "not in";

    omitted.push(`${plural(detached.length, "comment")} on text ${gone} v${artifact.version}`);
  }

  if (omitted.length > 0) lines.push("", `_${omitted.join(" and ")} omitted._`);

  return `${lines.join("\n").trimEnd()}\n`;
}
