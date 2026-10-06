import { load as loadYaml } from "js-yaml";

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | Date
  | FrontmatterValue[]
  | FrontmatterAttributes;

export interface FrontmatterAttributes {
  [key: string]: FrontmatterValue;
}

export interface FrontmatterResult {
  attributes: FrontmatterAttributes;
  body: string;
}

const MAX_FRONTMATTER_BYTES = 256 * 1024;

const MAX_FRONTMATTER_DEPTH = 32;

const MAX_FRONTMATTER_VALUES = 10_000;

const MAX_EXPANDED_CHARACTERS = 1024 * 1024;

interface TraversalBudget {
  remaining: number;
  characters: number;
}

function consumeCharacters(count: number, budget: TraversalBudget): void {
  budget.characters -= count;

  if (budget.characters < 0)
    throw new Error("Frontmatter exceeds the expanded text limit of 1 MiB.");
}

// YAML input can contain arbitrary values and alias graphs. Validate and copy it
// here so rendering only receives a bounded, acyclic tree of supported values.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function parseValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  budget: TraversalBudget,
): FrontmatterValue {
  if (depth > MAX_FRONTMATTER_DEPTH)
    throw new Error("Frontmatter exceeds the nesting limit of 32.");
  budget.remaining -= 1;

  if (budget.remaining < 0)
    throw new Error("Frontmatter exceeds the expanded value limit of 10000.");

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string") consumeCharacters(value.length, budget);

    return value;
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) return value;

  if (!Array.isArray(value) && !isMapping(value))
    throw new Error("Frontmatter contains an unsupported YAML value.");

  if (ancestors.has(value)) throw new Error("Frontmatter contains a cyclic YAML alias.");
  ancestors.add(value);

  try {
    if (Array.isArray(value))
      return value.map((entry) => parseValue(entry, ancestors, depth + 1, budget));

    const result: FrontmatterAttributes = Object.create(null);

    for (const [key, entry] of Object.entries(value)) {
      consumeCharacters(key.length, budget);
      result[key] = parseValue(entry, ancestors, depth + 1, budget);
    }

    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function parseFrontmatter(markdown: string): FrontmatterResult {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);

  if (!match) return { attributes: {}, body: normalized };
  const body = normalized.slice(match[0].length);

  try {
    const source = match[1] ?? "";

    if (new TextEncoder().encode(source).byteLength > MAX_FRONTMATTER_BYTES)
      throw new Error("Frontmatter exceeds the size limit of 256 KiB.");
    const value: unknown = loadYaml(source);

    if (!isMapping(value)) return { attributes: {}, body };

    const parsed = parseValue(value, new Set(), 0, {
      remaining: MAX_FRONTMATTER_VALUES,
      characters: MAX_EXPANDED_CHARACTERS,
    });

    // SAFETY: The root was checked as a mapping; parseValue copies mappings to
    // FrontmatterAttributes and validates every descendant before returning.
    return { attributes: parsed as FrontmatterAttributes, body };
  } catch (error) {
    return {
      attributes: {
        frontmatter_error: error instanceof Error ? error.message : "Invalid YAML frontmatter.",
      },
      body,
    };
  }
}
// oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
