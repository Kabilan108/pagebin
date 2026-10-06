import { type ContentFile, validPath, FILE_COUNT_LIMIT } from "../shared/content";
import {
  type DecisionControl,
  type DecisionOption,
  type DecisionValue,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewDecision,
  type ReviewRecord,
  REVIEW_LIMITS,
} from "../shared/review";
import { isAbsolute } from "node:path";

export interface ClientManifest {
  entrypoint: string;
  files: ContentFile[];
  sha256: string;
}

export interface PublishResponse {
  rawUrl?: string;
  downloadUrl?: string;
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  review: boolean;
  revision: number;
  version: number;
  contentSha256: string;
  attributes: ArtifactAttributes;
}

export interface ReissueResponse {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  revision: number;
}

export interface UpdateResponse {
  entrypoint?: string;
  id: string;
  filename: string;
  updatedAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  review: boolean;
  size: number;
  revision: number;
  version: number;
  contentSha256: string | null;
  attributes: ArtifactAttributes;
}

export interface DeleteResponse {
  id: string;
  deleted: boolean;
}

export interface ListResponse {
  artifacts: ListedArtifact[];
}

export interface ListedArtifact {
  id: string;
  filename: string;
  createdAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  review: boolean;
  size: number;
  revision: number;
  contentSha256: string | null;
  attributes: ArtifactAttributes;
}

export interface ArtifactAttributes {
  title?: string;
  project?: string;
  repo?: string;
  sourceHost?: string;
  gitBranch?: string;
  gitCommit?: string;
  sourcePath?: string;
  artifactType?: ArtifactType;
  agent?: string;
}

export interface ArtifactDetailResponse extends ListedArtifact {
  manifest?: ClientManifest;
  updatedAt: string;
  version: number;
  versions: ArtifactVersionSummary[];
}

export interface ArtifactVersionSummary {
  version: number;
  size: number;
  createdAt: string;
  contentSha256: string | null;
  current: boolean;
}

export interface VerificationResult {
  verified: true;
  method: "raw" | "metadata";
  id: string;
  url: string | null;
  localSha256: string;
  remoteSha256: string;
  size: number;
  revision: number | null;
}

export interface ArtifactReceipt {
  assets?: string[];
  bundle?: boolean;
  endpoint: string;
  id: string;
  url: string | null;
  rawUrl: string | null;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  review?: boolean;
  contentSha256: string | null;
  attributes: ArtifactAttributes;
  watch?: WatchOwnership;
}

export interface WatchOwnership {
  pid: number;
  host: string;
  startedAt: string;
}

export interface PublishClaim extends WatchOwnership {
  endpoint: string;
  filePath: string;
}

export interface ReceiptStore {
  schemaVersion: 1;
  artifacts: ArtifactReceipt[];
  claims?: PublishClaim[];
}

export type SandboxMode = "standard" | "strict";

export type ArtifactType =
  | "plan"
  | "report"
  | "review"
  | "explainer"
  | "implementation-log"
  | "other";

export interface ManifestResponse {
  manifest: ClientManifest;
  version: number;
  revision: number;
}

export interface UploadSessionResponse {
  id: string;
  sessionId: string;
  missing: string[];
}

export interface ReviewResponse {
  id: string;
  version: number;
  title: string;
  filename: string;
  review: ReviewRecord;
}

export interface ResolveReviewResponse {
  comments: ReviewComment[];
}

// This module validates untrusted JSON at the CLI's API and receipt boundaries.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isId(value: unknown): value is string {
  return isString(value) && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function isHttpUrl(value: unknown): value is string {
  if (!isString(value)) return false;

  try {
    const url = new URL(value);

    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isArtifactUrl(
  value: unknown,
  id: string,
  route: "p" | "raw" | "download",
): value is string {
  if (!isHttpUrl(value)) return false;
  const segments = new URL(value).pathname.split("/");

  return (
    segments[1] === route &&
    segments[2] === id &&
    isString(segments[3]) &&
    /^[A-Za-z0-9_-]+$/.test(segments[3])
  );
}

function isDate(value: unknown): value is string {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRevision(value: unknown): value is number {
  return isSize(value) && value > 0;
}

function isHash(value: unknown): value is string {
  return isString(value) && /^[a-f0-9]{64}$/.test(value);
}

function isSandbox(value: unknown): value is SandboxMode {
  return value === "standard" || value === "strict";
}

function isArtifactType(value: unknown): value is ArtifactType {
  return (
    value === "plan" ||
    value === "report" ||
    value === "review" ||
    value === "explainer" ||
    value === "implementation-log" ||
    value === "other"
  );
}

function isAttributes(value: unknown): value is ArtifactAttributes {
  if (!isObject(value)) return false;

  const stringKeys = [
    "title",
    "project",
    "repo",
    "sourceHost",
    "gitBranch",
    "gitCommit",
    "sourcePath",
    "agent",
  ];

  return (
    stringKeys.every((key) => value[key] === undefined || isString(value[key])) &&
    (value.artifactType === undefined || isArtifactType(value.artifactType))
  );
}

function isContentFile(value: unknown): value is ContentFile {
  return (
    isObject(value) &&
    isString(value.path) &&
    validPath(value.path) &&
    isString(value.contentType) &&
    isSize(value.size) &&
    isHash(value.sha256)
  );
}

function isManifest(value: unknown): value is ClientManifest {
  return (
    isObject(value) &&
    isString(value.entrypoint) &&
    validPath(value.entrypoint) &&
    isHash(value.sha256) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.length <= FILE_COUNT_LIMIT &&
    value.files.every(isContentFile) &&
    new Set(value.files.map((file) => file.path)).size === value.files.length &&
    value.files.some((file) => file.path === value.entrypoint)
  );
}

function isPublishResponse(value: unknown): value is PublishResponse {
  return (
    isObject(value) &&
    isId(value.id) &&
    isArtifactUrl(value.url, value.id, "p") &&
    (value.expiresAt === null || isDate(value.expiresAt)) &&
    isSandbox(value.sandbox) &&
    (value.review === undefined || typeof value.review === "boolean") &&
    isRevision(value.revision) &&
    isRevision(value.version) &&
    isHash(value.contentSha256) &&
    isAttributes(value.attributes) &&
    (value.rawUrl === undefined || isArtifactUrl(value.rawUrl, value.id, "raw")) &&
    (value.downloadUrl === undefined || isArtifactUrl(value.downloadUrl, value.id, "download"))
  );
}

function isReissueResponse(value: unknown): value is ReissueResponse {
  return (
    isObject(value) &&
    isId(value.id) &&
    isArtifactUrl(value.url, value.id, "p") &&
    (value.expiresAt === null || isDate(value.expiresAt)) &&
    isSandbox(value.sandbox) &&
    isRevision(value.revision)
  );
}

function isUpdateResponse(value: unknown): value is UpdateResponse {
  return (
    isObject(value) &&
    isId(value.id) &&
    isString(value.filename) &&
    isDate(value.updatedAt) &&
    (value.expiresAt === null || isDate(value.expiresAt)) &&
    isSandbox(value.sandbox) &&
    (value.review === undefined || typeof value.review === "boolean") &&
    isSize(value.size) &&
    isRevision(value.revision) &&
    isRevision(value.version) &&
    (value.contentSha256 === null || isHash(value.contentSha256)) &&
    isAttributes(value.attributes) &&
    (value.entrypoint === undefined || (isString(value.entrypoint) && validPath(value.entrypoint)))
  );
}

function isDeleteResponse(value: unknown): value is DeleteResponse {
  return isObject(value) && isId(value.id) && value.deleted === true;
}

function isListedArtifact(value: unknown): value is ListedArtifact {
  return (
    isObject(value) &&
    isId(value.id) &&
    isString(value.filename) &&
    isDate(value.createdAt) &&
    (value.expiresAt === null || isDate(value.expiresAt)) &&
    isSandbox(value.sandbox) &&
    (value.review === undefined || typeof value.review === "boolean") &&
    isSize(value.size) &&
    isRevision(value.revision) &&
    (value.contentSha256 === null || isHash(value.contentSha256)) &&
    isAttributes(value.attributes)
  );
}

function isListResponse(value: unknown): value is ListResponse {
  return (
    isObject(value) && Array.isArray(value.artifacts) && value.artifacts.every(isListedArtifact)
  );
}

function isVersionSummary(value: unknown): value is ArtifactVersionSummary {
  return (
    isObject(value) &&
    isRevision(value.version) &&
    isSize(value.size) &&
    isDate(value.createdAt) &&
    (value.contentSha256 === null || isHash(value.contentSha256)) &&
    typeof value.current === "boolean"
  );
}

function isArtifactDetailResponse(value: unknown): value is ArtifactDetailResponse {
  return (
    isListedArtifact(value) &&
    "updatedAt" in value &&
    isDate(value.updatedAt) &&
    "version" in value &&
    isRevision(value.version) &&
    "versions" in value &&
    Array.isArray(value.versions) &&
    value.versions.length > 0 &&
    value.versions.every(isVersionSummary) &&
    (!("manifest" in value) || value.manifest === undefined || isManifest(value.manifest))
  );
}

function isManifestResponse(value: unknown): value is ManifestResponse {
  return (
    isObject(value) &&
    isManifest(value.manifest) &&
    isRevision(value.version) &&
    isRevision(value.revision)
  );
}

function isWatchOwnership(value: unknown): value is WatchOwnership {
  return (
    isObject(value) &&
    isRevision(value.pid) &&
    isString(value.host) &&
    value.host.length > 0 &&
    isDate(value.startedAt)
  );
}

function isPublishClaim(value: unknown): value is PublishClaim {
  if (!isObject(value) || !isWatchOwnership(value)) return false;

  return isHttpUrl(value.endpoint) && isString(value.filePath) && isAbsolute(value.filePath);
}

function isArtifactReceipt(value: unknown): value is ArtifactReceipt {
  return (
    isObject(value) &&
    isHttpUrl(value.endpoint) &&
    isId(value.id) &&
    (value.url === null || isArtifactUrl(value.url, value.id, "p")) &&
    (value.rawUrl === null || isArtifactUrl(value.rawUrl, value.id, "raw")) &&
    isString(value.filePath) &&
    isAbsolute(value.filePath) &&
    isDate(value.createdAt) &&
    isDate(value.updatedAt) &&
    isRevision(value.revision) &&
    (value.review === undefined || typeof value.review === "boolean") &&
    (value.contentSha256 === null || isHash(value.contentSha256)) &&
    isAttributes(value.attributes) &&
    (value.assets === undefined || (Array.isArray(value.assets) && value.assets.every(isString))) &&
    (value.bundle === undefined || typeof value.bundle === "boolean") &&
    (value.watch === undefined || isWatchOwnership(value.watch))
  );
}

function isReceiptStore(value: unknown): value is ReceiptStore {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isArtifactReceipt) &&
    (value.claims === undefined ||
      (Array.isArray(value.claims) && value.claims.every(isPublishClaim)))
  );
}

function isUploadSessionResponse(value: unknown): value is UploadSessionResponse {
  return (
    isObject(value) &&
    isId(value.id) &&
    isId(value.sessionId) &&
    Array.isArray(value.missing) &&
    value.missing.every((path) => isString(path) && validPath(path)) &&
    new Set(value.missing).size === value.missing.length
  );
}

function isReviewAnchor(value: unknown): value is ReviewAnchor {
  return (
    isObject(value) &&
    isString(value.quote) &&
    value.quote.length <= REVIEW_LIMITS.quote &&
    isString(value.prefix) &&
    value.prefix.length <= REVIEW_LIMITS.anchorContext &&
    isString(value.suffix) &&
    value.suffix.length <= REVIEW_LIMITS.anchorContext &&
    isRevision(value.version)
  );
}

function isReviewComment(value: unknown): value is ReviewComment {
  return (
    isObject(value) &&
    isString(value.id) &&
    /^[A-Za-z0-9_-]+$/.test(value.id) &&
    isReviewAnchor(value.anchor) &&
    isString(value.body) &&
    value.body.length <= REVIEW_LIMITS.commentBody &&
    (value.status === "open" || value.status === "addressed") &&
    isDate(value.createdAt) &&
    isDate(value.updatedAt) &&
    (value.addressedAt === undefined || isDate(value.addressedAt))
  );
}

function isDecisionValue(value: unknown): value is DecisionValue {
  return (
    value === null ||
    isString(value) ||
    (Array.isArray(value) && value.every((item) => isString(item)))
  );
}

function isDecisionOption(value: unknown): value is DecisionOption {
  return isObject(value) && isString(value.value) && isString(value.label);
}

function isDecisionControl(value: unknown): value is DecisionControl {
  return (
    isObject(value) &&
    isString(value.name) &&
    (value.type === "radio" ||
      value.type === "checkbox" ||
      value.type === "range" ||
      value.type === "select" ||
      value.type === "text" ||
      value.type === "textarea") &&
    isDecisionValue(value.default) &&
    (value.options === undefined ||
      (Array.isArray(value.options) && value.options.every(isDecisionOption)))
  );
}

function isReviewDecision(value: unknown): value is ReviewDecision {
  return (
    isObject(value) &&
    isString(value.id) &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(value.id) &&
    isString(value.question) &&
    Array.isArray(value.controls) &&
    value.controls.every(isDecisionControl) &&
    isObject(value.values) &&
    Object.values(value.values).every(isDecisionValue) &&
    typeof value.interacted === "boolean" &&
    isRevision(value.answeredVersion) &&
    isDate(value.updatedAt) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= REVIEW_LIMITS.decisionBytes
  );
}

function isReviewRecord(value: unknown): value is ReviewRecord {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.comments) &&
    value.comments.length <= REVIEW_LIMITS.comments &&
    value.comments.every(isReviewComment) &&
    Array.isArray(value.decisions) &&
    value.decisions.length <= REVIEW_LIMITS.decisions &&
    value.decisions.every(isReviewDecision) &&
    (value.updatedAt === null || isDate(value.updatedAt)) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= REVIEW_LIMITS.recordBytes
  );
}

function isReviewResponse(value: unknown): value is ReviewResponse {
  return (
    isObject(value) &&
    isId(value.id) &&
    isRevision(value.version) &&
    isString(value.title) &&
    isString(value.filename) &&
    isReviewRecord(value.review)
  );
}

function isResolveReviewResponse(value: unknown): value is ResolveReviewResponse {
  return isObject(value) && Array.isArray(value.comments) && value.comments.every(isReviewComment);
}

function parseContract<T>(value: unknown, guard: (value: unknown) => value is T, name: string): T {
  if (!guard(value))
    throw new Error(`Invalid ${name}: response fields do not match the expected contract.`);

  return value;
}

export function parsePublishResponse(value: unknown): PublishResponse {
  const parsed = parseContract(value, isPublishResponse, "publish response");

  return { ...parsed, review: parsed.review ?? true };
}

export function parseReissueResponse(value: unknown): ReissueResponse {
  return parseContract(value, isReissueResponse, "reissue response");
}

export function parseUpdateResponse(value: unknown): UpdateResponse {
  const parsed = parseContract(value, isUpdateResponse, "update response");

  return { ...parsed, review: parsed.review ?? true };
}

export function parseDeleteResponse(value: unknown): DeleteResponse {
  return parseContract(value, isDeleteResponse, "delete response");
}

export function parseListResponse(value: unknown): ListResponse {
  const parsed = parseContract(value, isListResponse, "list response");

  return {
    artifacts: parsed.artifacts.map((artifact) => ({
      ...artifact,
      review: artifact.review ?? true,
    })),
  };
}

export function parseArtifactDetailResponse(value: unknown): ArtifactDetailResponse {
  const parsed = parseContract(value, isArtifactDetailResponse, "artifact detail response");

  return { ...parsed, review: parsed.review ?? true };
}

export function parseManifestResponse(value: unknown): ManifestResponse {
  return parseContract(value, isManifestResponse, "manifest response");
}

export function parseReceiptStore(value: unknown): ReceiptStore {
  return parseContract(value, isReceiptStore, "PageBin receipt store");
}

export function parseUploadSessionResponse(value: unknown): UploadSessionResponse {
  return parseContract(value, isUploadSessionResponse, "upload session response");
}

export function parseReviewResponse(value: unknown): ReviewResponse {
  return parseContract(value, isReviewResponse, "review response");
}

export function parseResolveReviewResponse(value: unknown): ResolveReviewResponse {
  return parseContract(value, isResolveReviewResponse, "review resolve response");
}
// oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
