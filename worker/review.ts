import {
  type DecisionControl,
  type DecisionOption,
  type DecisionValue,
  type DecisionWrite,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewCommentStatus,
  type ReviewDecision,
  type ReviewRecord,
  REVIEW_LIMITS,
  reviewDecisionForResponse,
  reviewRecordForResponse,
} from "../shared/review";

export interface ReviewStorageEnv {
  ARTIFACTS: R2Bucket;
}

export interface ReviewArtifact {
  id: string;
  filename: string;
  title: string;
  version: number;
  versions: number[];
  isLive: () => Promise<boolean>;
  isDeleted: () => Promise<boolean>;
}

interface StoredReview {
  review: ReviewRecord;
  etag: string | null;
}

interface ReviewMutation<T> {
  review: ReviewRecord;
  value: T;
}

class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413,
  ) {
    super(message);
  }
}

const REVIEW_WRITE_ATTEMPTS = 4;

const DECISION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const COMMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const WRITE_PAGE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const CONTROL_TYPES = new Set(["radio", "checkbox", "range", "select", "text", "textarea"]);

export function reviewObjectKey(id: string): string {
  return `artifacts/${id}/review.json`;
}

export function isReviewObjectKey(key: string): boolean {
  return key.endsWith("/review.json");
}

export function reviewNotFound(): Response {
  return reviewJson({ error: "Artifact not found." }, 404);
}

export async function getViewerReview(
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
): Promise<Response> {
  const { review } = await readStoredReview(env, artifact.id);

  return reviewJson({ review: reviewRecordForResponse(review), version: artifact.version });
}

export async function createViewerComment(
  request: Request,
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
): Promise<Response> {
  const parsedBody = await readJsonBody(request);

  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  if (!hasExactKeys(body, ["anchor", "body"])) {
    return badRequest("Comment body must contain only anchor and body.");
  }

  if (!isReviewAnchor(body.anchor) || !artifact.versions.includes(body.anchor.version)) {
    return badRequest("Comment anchor must reference an existing artifact version.");
  }

  if (!isBoundedString(body.body, REVIEW_LIMITS.commentBody)) {
    return badRequest(
      `Comment body must be a string of at most ${REVIEW_LIMITS.commentBody} characters.`,
    );
  }

  const now = new Date().toISOString();

  const comment: ReviewComment = {
    id: randomBase64Url(16),
    anchor: body.anchor,
    body: body.body,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };

  const result = await mutateReview(env, artifact, (review) => {
    if (review.comments.length >= REVIEW_LIMITS.comments) {
      throw new ReviewRequestError(
        `A review may contain at most ${REVIEW_LIMITS.comments} comments.`,
        413,
      );
    }

    return {
      review: updatedReview(review, { comments: [...review.comments, comment] }, now),
      value: comment,
    };
  });

  return "response" in result ? result.response : reviewJson({ comment: result.value }, 201);
}

export async function patchViewerComment(
  request: Request,
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
  commentId: string,
): Promise<Response> {
  if (!COMMENT_ID_PATTERN.test(commentId)) return reviewNotFound();

  const parsedBody = await readJsonBody(request);

  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  if (!hasOnlyKeys(body, ["body", "status"]) || Object.keys(body).length === 0) {
    return badRequest("Comment update must contain body, status, or both.");
  }

  if (Object.hasOwn(body, "body") && !isBoundedString(body.body, REVIEW_LIMITS.commentBody)) {
    return badRequest(
      `Comment body must be a string of at most ${REVIEW_LIMITS.commentBody} characters.`,
    );
  }

  if (Object.hasOwn(body, "status") && body.status !== "open") {
    return badRequest('Readers may only set comment status to "open".');
  }

  const replacementBody = isBoundedString(body.body, REVIEW_LIMITS.commentBody) ? body.body : null;
  const reopens = body.status === "open";
  const now = new Date().toISOString();

  const result = await mutateReview(env, artifact, (review) => {
    const index = review.comments.findIndex((comment) => comment.id === commentId);

    if (index === -1) throw new ReviewRequestError("Comment not found.", 404);

    const previous = review.comments[index]!;

    const comment: ReviewComment = {
      ...previous,
      ...(replacementBody !== null ? { body: replacementBody } : {}),
      ...(reopens ? { status: "open" as const } : {}),
      updatedAt: now,
    };

    if (reopens) delete comment.addressedAt;

    const comments = [...review.comments];
    comments[index] = comment;

    return {
      review: updatedReview(review, { comments }, now),
      value: comment,
    };
  });

  return "response" in result ? result.response : reviewJson({ comment: result.value });
}

export async function deleteViewerComment(
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
  commentId: string,
): Promise<Response> {
  if (!COMMENT_ID_PATTERN.test(commentId)) return reviewNotFound();

  const now = new Date().toISOString();

  const result = await mutateReview(env, artifact, (review) => {
    const index = review.comments.findIndex((comment) => comment.id === commentId);

    if (index === -1) throw new ReviewRequestError("Comment not found.", 404);

    const comments = [...review.comments];
    comments.splice(index, 1);

    return {
      review: updatedReview(review, { comments }, now),
      value: true,
    };
  });

  return "response" in result ? result.response : reviewJson({ deleted: true });
}

export async function putViewerDecision(
  request: Request,
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
  decisionId: string,
): Promise<Response> {
  const parsedBody = await readJsonBody(request);

  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  if (!DECISION_ID_PATTERN.test(decisionId)) {
    return badRequest("Decision id is invalid.");
  }

  const parsed = parseDecision(body, decisionId, artifact.versions);

  if ("response" in parsed) return parsed.response;

  const now = new Date().toISOString();
  const decision: ReviewDecision = { ...parsed.decision, updatedAt: now };

  if (serializedBytes(decision) > REVIEW_LIMITS.decisionBytes) {
    return tooLarge(`A decision may use at most ${REVIEW_LIMITS.decisionBytes} serialized bytes.`);
  }

  const result = await mutateReview(env, artifact, (review) => {
    const index = review.decisions.findIndex((candidate) => candidate.id === decisionId);
    const stored = review.decisions[index];

    if (stored && isStaleWrite(stored.lastWrite, decision.lastWrite)) {
      return { review, value: stored };
    }

    const decisions = [...review.decisions];

    if (index === -1) {
      if (decisions.length >= REVIEW_LIMITS.decisions) {
        throw new ReviewRequestError(
          `A review may contain at most ${REVIEW_LIMITS.decisions} decisions.`,
          413,
        );
      }

      decisions.push(decision);
    } else {
      decisions[index] = decision;
    }

    return {
      review: updatedReview(review, { decisions }, now),
      value: decision,
    };
  });

  return "response" in result
    ? result.response
    : reviewJson({ decision: reviewDecisionForResponse(result.value) });
}

export async function getPublisherReview(
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
): Promise<Response> {
  const { review } = await readStoredReview(env, artifact.id);

  return reviewJson({
    id: artifact.id,
    version: artifact.version,
    title: artifact.title,
    filename: artifact.filename,
    review: reviewRecordForResponse(review),
  });
}

export async function resolvePublisherComments(
  request: Request,
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
): Promise<Response> {
  const parsedBody = await readJsonBody(request);

  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  if (!hasOnlyKeys(body, ["commentIds", "status"]) || !Object.hasOwn(body, "commentIds")) {
    return badRequest("Resolve body must contain commentIds and may contain status.");
  }

  const requestedIds = body.commentIds;

  if (!isCommentIdArray(requestedIds)) {
    return badRequest("commentIds must be a non-empty array of unique comment ids.");
  }

  if (body.status !== undefined && body.status !== "addressed" && body.status !== "open") {
    return badRequest('Resolve status must be "addressed" or "open".');
  }

  const commentIds = new Set(requestedIds);
  const status: ReviewCommentStatus = body.status ?? "addressed";
  const now = new Date().toISOString();

  const result = await mutateReview(env, artifact, (review) => {
    const known = new Set(review.comments.map((comment) => comment.id));
    const missing = requestedIds.filter((id) => !known.has(id));

    if (missing.length > 0) {
      throw new ReviewRequestError(`Unknown comment ids: ${missing.join(", ")}.`, 404);
    }

    const changed: ReviewComment[] = [];

    const comments = review.comments.map((comment) => {
      if (!commentIds.has(comment.id)) return comment;

      const next: ReviewComment = {
        ...comment,
        status,
        updatedAt: now,
        ...(status === "addressed" ? { addressedAt: now } : {}),
      };

      if (status === "open") delete next.addressedAt;
      changed.push(next);

      return next;
    });

    return {
      review: updatedReview(review, { comments }, now),
      value: changed,
    };
  });

  return "response" in result ? result.response : reviewJson({ comments: result.value });
}

type MutationResult<T> = { value: T } | { response: Response };

async function mutateReview<T>(
  env: ReviewStorageEnv,
  artifact: ReviewArtifact,
  mutate: (review: ReviewRecord) => ReviewMutation<T>,
): Promise<MutationResult<T>> {
  for (let attempt = 0; attempt < REVIEW_WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0 && !(await artifact.isLive())) {
      return { response: reviewNotFound() };
    }

    const stored = await readStoredReview(env, artifact.id);

    let mutation: ReviewMutation<T>;

    try {
      mutation = mutate(stored.review);
    } catch (error) {
      if (error instanceof ReviewRequestError) {
        return { response: reviewJson({ error: error.message }, error.status) };
      }

      throw error;
    }

    const serializedReview = JSON.stringify(mutation.review);

    if (new TextEncoder().encode(serializedReview).byteLength > REVIEW_LIMITS.recordBytes) {
      return {
        response: tooLarge(
          `A review may use at most ${REVIEW_LIMITS.recordBytes} serialized bytes.`,
        ),
      };
    }

    const result = await env.ARTIFACTS.put(reviewObjectKey(artifact.id), serializedReview, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      onlyIf: stored.etag ? { etagMatches: stored.etag } : { etagDoesNotMatch: "*" },
    });

    if (result !== null) {
      if (!(await artifact.isLive())) {
        // Only a tombstone is final. An expired artifact can still be extended, so expiry
        // cleanup is left to the sweep, which retires it through the metadata CAS.
        if (await artifact.isDeleted()) await env.ARTIFACTS.delete(reviewObjectKey(artifact.id));

        return { response: reviewNotFound() };
      }

      return { value: mutation.value };
    }
  }

  return {
    response: reviewJson({ error: "Review changed concurrently. Retry the request." }, 409),
  };
}

async function readStoredReview(env: ReviewStorageEnv, id: string): Promise<StoredReview> {
  const object = await env.ARTIFACTS.get(reviewObjectKey(id));

  if (!object) {
    return { review: emptyReview(), etag: null };
  }

  const value: unknown = JSON.parse(await object.text());
  const review = isPlainObject(value) && Object.hasOwn(value, "review") ? value.review : value;

  if (isReviewRecord(review)) {
    return {
      review,
      etag: object.etag,
    };
  }

  throw new Error(`Stored review for ${id} does not match schema version 1.`);
}

function emptyReview(): ReviewRecord {
  return { schemaVersion: 1, comments: [], decisions: [], updatedAt: null };
}

function updatedReview(
  review: ReviewRecord,
  change: { comments?: ReviewComment[]; decisions?: ReviewDecision[] },
  updatedAt: string,
): ReviewRecord {
  return {
    ...review,
    ...(change.comments ? { comments: change.comments } : {}),
    ...(change.decisions ? { decisions: change.decisions } : {}),
    updatedAt,
  };
}

// Review request and stored-record validators narrow external JSON into the shared contract.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters
type ParsedBody = { body: Record<string, unknown> } | { response: Response };

async function readJsonBody(request: Request): Promise<ParsedBody> {
  try {
    return { body: await parseJsonBody(request) };
  } catch (error) {
    if (error instanceof ReviewRequestError) {
      return { response: reviewJson({ error: error.message }, error.status) };
    }

    throw error;
  }
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const lengthValue = request.headers.get("Content-Length");
  const length = lengthValue && /^\d+$/.test(lengthValue) ? Number(lengthValue) : Number.NaN;

  if (!Number.isSafeInteger(length) || length > REVIEW_LIMITS.requestBytes) {
    throw new ReviewRequestError(
      `Review requests require Content-Length of at most ${REVIEW_LIMITS.requestBytes} bytes.`,
      413,
    );
  }

  if (
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ReviewRequestError("Review mutations require Content-Type: application/json.", 400);
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).byteLength > REVIEW_LIMITS.requestBytes) {
    throw new ReviewRequestError(
      `Review requests may use at most ${REVIEW_LIMITS.requestBytes} bytes.`,
      413,
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new ReviewRequestError("Review body must be valid JSON.", 400);
  }

  if (!isPlainObject(value)) {
    throw new ReviewRequestError("Review body must be a JSON object.", 400);
  }

  return value;
}

type ParsedDecision = { decision: Omit<ReviewDecision, "updatedAt"> } | { response: Response };

function parseDecision(
  value: Record<string, unknown>,
  pathId: string,
  artifactVersions: number[],
): ParsedDecision {
  const keys = ["id", "question", "controls", "values", "interacted", "answeredVersion"];

  if (
    !hasOnlyKeys(value, [...keys, "clientSeq"]) ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    return {
      response: badRequest(
        `Decision body must contain ${keys.join(", ")} and may contain clientSeq.`,
      ),
    };
  }

  if (value.clientSeq !== undefined && !isDecisionWrite(value.clientSeq)) {
    return { response: badRequest("Decision clientSeq must be { page, n } with a positive n.") };
  }

  if (value.id !== pathId || typeof value.id !== "string") {
    return { response: badRequest("Decision id must match the path id.") };
  }

  if (typeof value.question !== "string") {
    return { response: badRequest("Decision question must be a string.") };
  }

  if (!isDecisionControls(value.controls)) {
    return { response: badRequest("Decision controls are invalid.") };
  }

  const controls = value.controls;
  const controlNames = new Set<string>();

  for (const control of controls) {
    if (
      (control.name !== pathId &&
        (!control.name.startsWith(`${pathId}:`) || control.name.length === pathId.length + 1)) ||
      controlNames.has(control.name)
    ) {
      return {
        response: badRequest(
          "Control names must be unique and equal the decision id or use its prefix.",
        ),
      };
    }

    controlNames.add(control.name);
  }

  if (!isDecisionValues(value.values, controlNames)) {
    return { response: badRequest("Decision values must match declared control names.") };
  }

  if (typeof value.interacted !== "boolean") {
    return { response: badRequest("Decision interacted must be a boolean.") };
  }

  if (
    typeof value.answeredVersion !== "number" ||
    !Number.isSafeInteger(value.answeredVersion) ||
    !artifactVersions.includes(value.answeredVersion)
  ) {
    return { response: badRequest("Decision answeredVersion must reference an existing version.") };
  }

  return {
    decision: {
      id: value.id,
      question: value.question,
      controls,
      values: value.values,
      interacted: value.interacted,
      answeredVersion: value.answeredVersion,
      ...(isDecisionWrite(value.clientSeq) ? { lastWrite: value.clientSeq } : {}),
    },
  };
}

function isDecisionWrite(value: unknown): value is DecisionWrite {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["page", "n"]) &&
    typeof value.page === "string" &&
    WRITE_PAGE_PATTERN.test(value.page) &&
    typeof value.n === "number" &&
    Number.isSafeInteger(value.n) &&
    value.n > 0
  );
}

// Writes from other pages always apply; within one page load, only a higher counter does.
function isStaleWrite(
  stored: DecisionWrite | undefined,
  incoming: DecisionWrite | undefined,
): boolean {
  return (
    stored !== undefined &&
    incoming !== undefined &&
    stored.page === incoming.page &&
    incoming.n <= stored.n
  );
}

function isReviewRecord(value: unknown): value is ReviewRecord {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["schemaVersion", "comments", "decisions", "updatedAt"]) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.comments) &&
    value.comments.length <= REVIEW_LIMITS.comments &&
    value.comments.every(isReviewComment) &&
    Array.isArray(value.decisions) &&
    value.decisions.length <= REVIEW_LIMITS.decisions &&
    value.decisions.every(isReviewDecision) &&
    (value.updatedAt === null || isIsoDate(value.updatedAt)) &&
    serializedBytes(value) <= REVIEW_LIMITS.recordBytes
  );
}

function isReviewComment(value: unknown): value is ReviewComment {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, [
      "id",
      "anchor",
      "body",
      "status",
      "createdAt",
      "updatedAt",
      "addressedAt",
    ]) &&
    typeof value.id === "string" &&
    COMMENT_ID_PATTERN.test(value.id) &&
    isReviewAnchor(value.anchor) &&
    isBoundedString(value.body, REVIEW_LIMITS.commentBody) &&
    (value.status === "open" || value.status === "addressed") &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    (value.addressedAt === undefined || isIsoDate(value.addressedAt))
  );
}

function isReviewAnchor(value: unknown): value is ReviewAnchor {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["quote", "prefix", "suffix", "version"]) &&
    isBoundedString(value.quote, REVIEW_LIMITS.quote) &&
    isBoundedString(value.prefix, REVIEW_LIMITS.anchorContext) &&
    isBoundedString(value.suffix, REVIEW_LIMITS.anchorContext) &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0
  );
}

function isReviewDecision(value: unknown): value is ReviewDecision {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, [
      "id",
      "question",
      "controls",
      "values",
      "interacted",
      "answeredVersion",
      "updatedAt",
      "lastWrite",
    ]) &&
    ["id", "question", "controls", "values", "interacted", "answeredVersion", "updatedAt"].every(
      (key) => Object.hasOwn(value, key),
    ) &&
    (value.lastWrite === undefined || isDecisionWrite(value.lastWrite)) &&
    typeof value.id === "string" &&
    DECISION_ID_PATTERN.test(value.id) &&
    typeof value.question === "string" &&
    Array.isArray(value.controls) &&
    value.controls.every(isDecisionControl) &&
    isPlainObject(value.values) &&
    Object.values(value.values).every(isDecisionValue) &&
    typeof value.interacted === "boolean" &&
    typeof value.answeredVersion === "number" &&
    Number.isSafeInteger(value.answeredVersion) &&
    value.answeredVersion > 0 &&
    isIsoDate(value.updatedAt) &&
    serializedBytes(value) <= REVIEW_LIMITS.decisionBytes
  );
}

function isDecisionControl(value: unknown): value is DecisionControl {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, ["name", "type", "default", "options"]) &&
    Object.hasOwn(value, "name") &&
    Object.hasOwn(value, "type") &&
    Object.hasOwn(value, "default") &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    CONTROL_TYPES.has(value.type) &&
    isDecisionValue(value.default) &&
    (value.options === undefined ||
      (Array.isArray(value.options) && value.options.every(isDecisionOption)))
  );
}

function isDecisionControls(value: unknown): value is DecisionControl[] {
  return Array.isArray(value) && value.every(isDecisionControl);
}

function isDecisionOption(value: unknown): value is DecisionOption {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["value", "label"]) &&
    typeof value.value === "string" &&
    typeof value.label === "string"
  );
}

function isDecisionValue(value: unknown): value is DecisionValue {
  return (
    value === null ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function isDecisionValues(
  value: unknown,
  controlNames: Set<string>,
): value is Record<string, DecisionValue> {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === controlNames.size &&
    Object.entries(value).every(
      ([name, answer]) => controlNames.has(name) && isDecisionValue(answer),
    )
  );
}

function isCommentIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= REVIEW_LIMITS.comments &&
    value.every((id) => typeof id === "string" && COMMENT_ID_PATTERN.test(id)) &&
    new Set(value).size === value.length
  );
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const time = Date.parse(value);

  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function serializedBytes(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function badRequest(error: string): Response {
  return reviewJson({ error }, 400);
}

function tooLarge(error: string): Response {
  return reviewJson({ error }, 413);
}

function reviewJson(payload: object, status = 200): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });

  headers.set("Cache-Control", "private, max-age=0, no-store, no-transform");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  return new Response(JSON.stringify(payload), { status, headers });
}
