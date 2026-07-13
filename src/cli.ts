#!/usr/bin/env bun

import { watch } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, relative, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { renderMarkdownDocument } from "./markdown-template.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SANDBOX = "standard";
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const VERSION = packageJson.version;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const HTML_EXTENSION = ".html";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const OUTPUT_SCHEMA_VERSION = 1;

interface PublishResponse {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  revision: number;
  contentSha256: string;
  attributes: ArtifactAttributes;
}

interface ReissueResponse {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  revision: number;
}

interface UpdateResponse {
  id: string;
  filename: string;
  updatedAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  size: number;
  revision: number;
  contentSha256: string;
  attributes: ArtifactAttributes;
}

interface DeleteResponse {
  id: string;
  deleted: boolean;
}

interface ListResponse {
  artifacts: ListedArtifact[];
}

interface ListedArtifact {
  id: string;
  filename: string;
  createdAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  size: number;
  revision: number;
  contentSha256: string | null;
  attributes: ArtifactAttributes;
}

interface ArtifactAttributes {
  title?: string;
  project?: string;
  repo?: string;
  sourceHost?: string;
  gitBranch?: string;
  gitCommit?: string;
  sourcePath?: string;
  artifactType?: ArtifactType;
  status?: ArtifactStatus;
  agent?: string;
}

interface ArtifactDetailResponse extends ListedArtifact {
  updatedAt: string;
}

interface VerificationResult {
  verified: true;
  method: "raw" | "metadata";
  id: string;
  url: string | null;
  localSha256: string;
  remoteSha256: string;
  size: number;
  revision: number | null;
}

interface ArtifactReceipt {
  endpoint: string;
  id: string;
  url: string | null;
  rawUrl: string | null;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  contentSha256: string | null;
  attributes: ArtifactAttributes;
  watch?: WatchOwnership;
}

interface WatchOwnership {
  pid: number;
  host: string;
  startedAt: string;
}

interface ReceiptStore {
  schemaVersion: 1;
  artifacts: ArtifactReceipt[];
}

interface PublishOptions {
  endpoint: string;
  filePath: string;
  json: boolean;
  sandbox: SandboxMode;
  ttlSeconds: number | null;
  verify: boolean;
  inferMetadata: boolean;
  attributes: ArtifactAttributes;
  forceNew: boolean;
}

interface DeleteOptions {
  endpoint: string;
  id: string;
  json: boolean;
}

interface ReissueOptions {
  endpoint: string;
  id: string;
  json: boolean;
}

interface UpdateOptions {
  endpoint: string;
  filePath: string;
  id: string;
  json: boolean;
  url: string | null;
  inferMetadata: boolean;
  attributes: ArtifactAttributes;
  receiptLookup: boolean;
}

interface WatchPublishOptions extends PublishOptions {
  mode: "publish";
}

interface WatchUpdateOptions extends UpdateOptions {
  mode: "update";
}

type WatchOptions = WatchPublishOptions | WatchUpdateOptions;

interface ListOptions {
  endpoint: string;
  json: boolean;
}

interface VerifyOptions {
  endpoint: string;
  filePath: string;
  id: string;
  json: boolean;
  url: string | null;
}

interface HelpOptions {
  topic: HelpTopic | null;
}

interface ReceiptListOptions {
  json: boolean;
}

interface ShowOptions {
  json: boolean;
  target: string;
}

interface ArtifactTarget {
  id: string;
  url: string | null;
  urlOrigin: string | null;
}

interface ParsedCommand {
  command: "publish" | "delete" | "reissue" | "update" | "watch" | "list" | "verify" | "receipts" | "show" | "help" | "version";
  options?: PublishOptions | DeleteOptions | ReissueOptions | UpdateOptions | WatchOptions | ListOptions | VerifyOptions | ReceiptListOptions | ShowOptions | HelpOptions;
}

type SandboxMode = "standard" | "strict";
type UploadSourceKind = "html" | "markdown";
type ArtifactType = "plan" | "report" | "review" | "explainer" | "implementation-log" | "other";
type ArtifactStatus = "draft" | "active" | "done" | "superseded" | "archived";
type HelpTopic = Exclude<ParsedCommand["command"], "help">;

const ATTRIBUTE_FLAGS: Record<string, keyof ArtifactAttributes> = {
  "--title": "title",
  "--project": "project",
  "--repo": "repo",
  "--source-host": "sourceHost",
  "--git-branch": "gitBranch",
  "--git-commit": "gitCommit",
  "--source-path": "sourcePath",
  "--type": "artifactType",
  "--status": "status",
  "--agent": "agent",
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function parseTtlSeconds(value: string): number {
  const match = value.match(/^([1-9]\d*)([smhdw])$/);

  if (!match) {
    throw new CliError("TTL must look like 30m, 12h, 7d, or 2w.");
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
  };

  if (!unit) {
    throw new CliError("TTL must include a unit.");
  }

  const multiplier = multipliers[unit as keyof typeof multipliers];

  if (!multiplier) {
    throw new CliError("TTL must use s, m, h, d, or w.");
  }

  const ttlSeconds = amount * multiplier;

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds > MAX_TTL_SECONDS) {
    throw new CliError("TTL must be 10 years or less.");
  }

  return ttlSeconds;
}

export function normalizeEndpoint(value: string): string {
  const endpoint = value.trim().replace(/\/+$/, "");

  if (!endpoint) {
    throw new CliError("PAGEBIN_ENDPOINT is required.");
  }

  try {
    const url = new URL(endpoint);

    if (url.protocol !== "https:" && !isLocalhost(url.hostname)) {
      throw new CliError("PAGEBIN_ENDPOINT must use https unless it points at localhost.");
    }

    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw new CliError("PAGEBIN_ENDPOINT must be a valid URL.");
  }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCommand {
  const [command, ...rest] = argv;

  if (!command || isHelpFlag(command)) {
    return { command: "help", options: { topic: null } };
  }

  if (command === "help") {
    return parseHelpOptions(rest);
  }

  if (isHelpTopic(command) && rest.some(isHelpFlag)) {
    return { command: "help", options: { topic: command } };
  }

  if (command === "version" || command === "--version" || command === "-v") {
    return { command: "version" };
  }

  if (command === "publish") {
    return {
      command,
      options: parsePublishOptions(rest, env),
    };
  }

  if (command === "delete") {
    return {
      command,
      options: parseDeleteOptions(rest, env),
    };
  }

  if (command === "reissue") {
    return {
      command,
      options: parseReissueOptions(rest, env),
    };
  }

  if (command === "update") {
    return {
      command,
      options: parseUpdateOptions(rest, env),
    };
  }

  if (command === "watch") {
    return {
      command,
      options: parseWatchOptions(rest, env),
    };
  }

  if (command === "list") {
    return {
      command,
      options: parseListOptions(rest, env),
    };
  }


  if (command === "verify") {
    return {
      command,
      options: parseVerifyOptions(rest, env),
    };
  }


  if (command === "receipts") {
    return { command, options: parseReceiptListOptions(rest) };
  }

  if (command === "show") {
    return { command, options: parseShowOptions(rest) };
  }

  throw new CliError(`Unknown command: ${command}`);
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));

    switch (parsed.command) {
      case "publish":
        await publishArtifact(parsed.options as PublishOptions);
        return;
      case "delete":
        await deleteArtifact(parsed.options as DeleteOptions);
        return;
      case "reissue":
        await reissueArtifact(parsed.options as ReissueOptions);
        return;
      case "update":
        await updateArtifact(parsed.options as UpdateOptions);
        return;
      case "watch":
        await watchArtifact(parsed.options as WatchOptions);
        return;
      case "list":
        await listArtifacts(parsed.options as ListOptions);
        return;
      case "verify":
        await verifyArtifact(parsed.options as VerifyOptions);
        return;
      case "receipts":
        await listReceipts(parsed.options as ReceiptListOptions);
        return;
      case "show":
        await showReceipt(parsed.options as ShowOptions);
        return;
      case "version":
        console.log(VERSION);
        return;
      case "help":
        console.log(helpText((parsed.options as HelpOptions | undefined)?.topic ?? null));
        return;
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }

    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function parseHelpOptions(args: string[]): ParsedCommand {
  const [topic] = args;

  if (args.length === 0 || (args.length === 1 && isHelpFlag(topic))) {
    return { command: "help", options: { topic: null } };
  }

  if (args.length === 1 && topic && isHelpTopic(topic)) {
    return { command: "help", options: { topic } };
  }

  throw new CliError("help accepts one command name, for example: pagebin help watch.");
}

function parsePublishOptions(args: string[], env: NodeJS.ProcessEnv): PublishOptions {
  const endpoint = normalizeEndpoint(readEndpoint(args, env));
  let filePath: string | null = null;
  let json = false;
  let sandbox: SandboxMode = DEFAULT_SANDBOX;
  let ttlSeconds: number | null = null;
  let verify = false;
  let forceNew = false;
  let inferMetadata = true;
  const attributes: ArtifactAttributes = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--verify") {
      verify = true;
      continue;
    }

    if (arg === "--force-new") {
      forceNew = true;
      continue;
    }

    if (arg === "--no-infer") {
      inferMetadata = false;
      continue;
    }

    const attributeIndex = parseArtifactAttributeOption(args, index, attributes);

    if (attributeIndex !== null) {
      index = attributeIndex;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    if (arg === "--ttl") {
      index += 1;
      ttlSeconds = parseTtlSeconds(requireValue(args[index], "--ttl"));
      continue;
    }

    if (arg === "--sandbox") {
      index += 1;
      sandbox = parseSandbox(requireValue(args[index], "--sandbox"));
      continue;
    }

    if (arg?.startsWith("-")) {
      throw new CliError(`Unknown option for publish: ${arg}`);
    }

    if (filePath) {
      throw new CliError("publish accepts exactly one file path.");
    }

    filePath = arg ?? null;
  }

  if (!filePath) {
    throw new CliError("publish requires a .html, .md, or .markdown file path.");
  }

  return {
    endpoint,
    filePath,
    json,
    sandbox,
    ttlSeconds,
    verify,
    inferMetadata,
    attributes,
    forceNew,
  };
}

function parseDeleteOptions(args: string[], env: NodeJS.ProcessEnv): DeleteOptions {
  const endpoint = normalizeEndpoint(readEndpoint(args, env));
  let id: string | null = null;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    if (arg?.startsWith("-") && !isArtifactId(arg)) {
      throw new CliError(`Unknown option for delete: ${arg}`);
    }

    if (id) {
      throw new CliError("delete accepts exactly one artifact ID.");
    }

    id = arg ?? null;
  }

  if (!id) {
    throw new CliError("delete requires an artifact ID.");
  }

  return {
    endpoint,
    id,
    json,
  };
}

function parseReissueOptions(args: string[], env: NodeJS.ProcessEnv): ReissueOptions {
  const endpoint = normalizeEndpoint(readEndpoint(args, env));
  let id: string | null = null;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    if (arg?.startsWith("-") && !isArtifactId(arg)) {
      throw new CliError(`Unknown option for reissue: ${arg}`);
    }

    if (id) {
      throw new CliError("reissue accepts exactly one artifact ID.");
    }

    id = arg ?? null;
  }

  if (!id) {
    throw new CliError("reissue requires an artifact ID.");
  }

  return {
    endpoint,
    id,
    json,
  };
}

function parseUpdateOptions(args: string[], env: NodeJS.ProcessEnv): UpdateOptions {
  let filePath: string | null = null;
  let json = false;
  let targetValue: string | null = null;
  let inferMetadata = true;
  const attributes: ArtifactAttributes = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--no-infer") {
      inferMetadata = false;
      continue;
    }

    const attributeIndex = parseArtifactAttributeOption(args, index, attributes);

    if (attributeIndex !== null) {
      index = attributeIndex;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    if (arg?.startsWith("-") && !isArtifactId(arg)) {
      throw new CliError(`Unknown option for update: ${arg}`);
    }

    if (!targetValue) {
      targetValue = arg ?? null;
      continue;
    }

    if (!filePath) {
      filePath = arg ?? null;
      continue;
    }

    throw new CliError("update accepts exactly one artifact target and one file path.");
  }

  if (!targetValue) {
    throw new CliError("update requires an artifact ID or viewer URL.");
  }

  if (!filePath && isSupportedArtifactFile(targetValue)) {
    return {
      endpoint: normalizeEndpoint(readEndpoint(args, env)),
      filePath: targetValue,
      id: "",
      json,
      url: null,
      inferMetadata,
      attributes,
      receiptLookup: true,
    };
  }

  if (!filePath) {
    throw new CliError("update requires a .html, .md, or .markdown file path.");
  }

  const target = parseArtifactTarget(targetValue);
  const endpoint = normalizeEndpoint(readEndpointOption(args) ?? env.PAGEBIN_ENDPOINT ?? managementOrigin(target.urlOrigin) ?? "");

  return {
    endpoint,
    filePath,
    id: target.id,
    json,
    url: target.url,
    inferMetadata,
    attributes,
    receiptLookup: false,
  };
}

function parseWatchOptions(args: string[], env: NodeJS.ProcessEnv): WatchOptions {
  const values: string[] = [];
  let sandbox: SandboxMode = DEFAULT_SANDBOX;
  let sandboxProvided = false;
  let ttlProvided = false;
  let ttlSeconds: number | null = null;
  let inferMetadata = true;
  let metadataProvided = false;
  const attributes: ArtifactAttributes = {};
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--no-infer") {
      inferMetadata = false;
      metadataProvided = true;
      continue;
    }

    const attributeIndex = parseArtifactAttributeOption(args, index, attributes);

    if (attributeIndex !== null) {
      index = attributeIndex;
      metadataProvided = true;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    if (arg === "--ttl") {
      index += 1;
      ttlProvided = true;
      ttlSeconds = parseTtlSeconds(requireValue(args[index], "--ttl"));
      continue;
    }

    if (arg === "--sandbox") {
      index += 1;
      sandboxProvided = true;
      sandbox = parseSandbox(requireValue(args[index], "--sandbox"));
      continue;
    }

    if (arg?.startsWith("-") && !isArtifactId(arg)) {
      throw new CliError(`Unknown option for watch: ${arg}`);
    }

    values.push(arg ?? "");

    if (values.length > 2) {
      throw new CliError("watch accepts either one file path or one artifact target and one file path.");
    }
  }

  if (values.length === 0) {
    throw new CliError("watch requires a .html, .md, or .markdown file path.");
  }

  if (values.length === 1) {
    const filePath = values[0] ?? "";

    if (isArtifactTargetLike(filePath)) {
      throw new CliError("watch with an artifact target also requires a .html, .md, or .markdown file path.");
    }

    return {
      endpoint: normalizeEndpoint(readEndpoint(args, env)),
      filePath,
      json,
      mode: "publish",
      sandbox,
      ttlSeconds,
      verify: false,
      inferMetadata,
      attributes,
      forceNew: false,
    };
  }

  if (ttlProvided) {
    throw new CliError("--ttl can only be used with pagebin watch <file>.");
  }

  if (sandboxProvided) {
    throw new CliError("--sandbox can only be used with pagebin watch <file>.");
  }

  if (metadataProvided) {
    throw new CliError("Metadata options can only be used with pagebin watch <file>.");
  }

  const [targetValue, filePath] = values;

  if (!targetValue || !filePath) {
    throw new CliError("watch accepts either one file path or one artifact target and one file path.");
  }

  const target = parseArtifactTarget(targetValue);
  const endpoint = normalizeEndpoint(readEndpointOption(args) ?? env.PAGEBIN_ENDPOINT ?? managementOrigin(target.urlOrigin) ?? "");

  return {
    endpoint,
    filePath,
    id: target.id,
    json,
    mode: "update",
    url: target.url,
    inferMetadata: false,
    attributes: {},
    receiptLookup: false,
  };
}

function parseListOptions(args: string[], env: NodeJS.ProcessEnv): ListOptions {
  const endpoint = normalizeEndpoint(readEndpoint(args, env));
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    throw new CliError(`Unknown option for list: ${arg}`);
  }

  return {
    endpoint,
    json,
  };
}

function parseVerifyOptions(args: string[], env: NodeJS.ProcessEnv): VerifyOptions {
  let filePath: string | null = null;
  let json = false;
  let targetValue: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--endpoint") {
      index += 1;
      requireValue(args[index], "--endpoint");
      continue;
    }

    if (arg?.startsWith("-") && !isArtifactId(arg)) {
      throw new CliError(`Unknown option for verify: ${arg}`);
    }

    if (!targetValue) {
      targetValue = arg ?? null;
      continue;
    }

    if (!filePath) {
      filePath = arg ?? null;
      continue;
    }

    throw new CliError("verify accepts exactly one artifact target and one file path.");
  }

  if (!targetValue) {
    throw new CliError("verify requires an artifact ID or viewer URL.");
  }

  if (!filePath) {
    throw new CliError("verify requires a .html, .md, or .markdown file path.");
  }

  const target = parseArtifactTarget(targetValue);
  const endpoint = normalizeEndpoint(readEndpointOption(args) ?? target.urlOrigin ?? env.PAGEBIN_ENDPOINT ?? "");

  return {
    endpoint,
    filePath,
    id: target.id,
    json,
    url: target.url,
  };
}

function parseReceiptListOptions(args: string[]): ReceiptListOptions {
  if (args.length === 0) {
    return { json: false };
  }

  if (args.length === 1 && args[0] === "--json") {
    return { json: true };
  }

  throw new CliError("receipts only accepts --json.");
}

function parseShowOptions(args: string[]): ShowOptions {
  const values = args.filter((arg) => arg !== "--json");

  if (values.length !== 1 || !values[0]) {
    throw new CliError("show requires one artifact ID, viewer URL, or local file path.");
  }

  return { json: args.includes("--json"), target: values[0] };
}

function readEndpoint(args: string[], env: NodeJS.ProcessEnv): string {
  return readOptionalEndpoint(args, env) ?? "";
}

function managementOrigin(viewerOrigin: string | null): string | null {
  if (viewerOrigin === "https://page-bin.com") {
    return "https://api.page-bin.com";
  }

  return viewerOrigin;
}

function readOptionalEndpoint(args: string[], env: NodeJS.ProcessEnv): string | null {
  return readEndpointOption(args) ?? env.PAGEBIN_ENDPOINT ?? null;
}

function readEndpointOption(args: string[]): string | null {
  const endpointIndex = args.indexOf("--endpoint");

  if (endpointIndex === -1) {
    return null;
  }

  return requireValue(args[endpointIndex + 1], "--endpoint");
}

function parseArtifactTarget(value: string): ArtifactTarget {
  if (isArtifactId(value)) {
    return {
      id: value,
      url: null,
      urlOrigin: null,
    };
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new CliError("Artifact target must be an artifact ID or pagebin viewer URL.");
  }

  if (url.protocol !== "https:" && !isLocalhost(url.hostname)) {
    throw new CliError("Artifact viewer URL must use https unless it points at localhost.");
  }

  const match = url.pathname.match(/^\/(?:p|raw)\/([^/]+)\/([^/]+)$/);

  if (!match?.[1] || !isArtifactId(match[1])) {
    throw new CliError("Artifact viewer URL must look like /p/<artifact_id>/<token>.");
  }

  return {
    id: match[1],
    url: url.toString(),
    urlOrigin: url.origin,
  };
}

function parseArtifactAttributeOption(
  args: string[],
  index: number,
  attributes: ArtifactAttributes,
): number | null {
  const arg = args[index];
  const key = arg ? ATTRIBUTE_FLAGS[arg] : undefined;

  if (!key || !arg) {
    return null;
  }

  const value = requireValue(args[index + 1], arg);

  if (key === "artifactType" && !isArtifactType(value)) {
    throw new CliError("--type must be plan, report, review, explainer, implementation-log, or other.");
  }

  if (key === "status" && !isArtifactStatus(value)) {
    throw new CliError("--status must be draft, active, done, superseded, or archived.");
  }

  (attributes as Record<string, string>)[key] = value;
  return index + 1;
}

function isArtifactType(value: string): value is ArtifactType {
  return value === "plan" || value === "report" || value === "review" || value === "explainer" || value === "implementation-log" || value === "other";
}

function isArtifactStatus(value: string): value is ArtifactStatus {
  return value === "draft" || value === "active" || value === "done" || value === "superseded" || value === "archived";
}

function parseSandbox(value: string): SandboxMode {
  if (value === "standard" || value === "strict") {
    return value;
  }

  throw new CliError("Sandbox must be standard or strict.");
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("-")) {
    throw new CliError(`${flag} requires a value.`);
  }

  return value;
}

async function publishArtifact(options: PublishOptions, output = true): Promise<PublishResponse> {
  assertSandboxSupportsFile(options.filePath, options.sandbox);

  const token = readPublishToken();
  const { form } = await createHtmlUploadForm(options.filePath);
  const attributes = await resolveArtifactAttributes(options.filePath, options.attributes, options.inferMetadata);
  const absoluteFilePath = resolve(options.filePath);
  const existingReceipt = await findReceiptByFile(options.endpoint, absoluteFilePath);

  if (existingReceipt && !options.forceNew) {
    const watcher = describeActiveWatcher(existingReceipt);
    throw new CliError(
      `This file is already published as ${existingReceipt.id}${watcher}. Use pagebin update ${existingReceipt.id} ${options.filePath} or pass --force-new.`,
    );
  }

  form.set("sandbox", options.sandbox);
  setArtifactAttributes(form, attributes);

  if (options.ttlSeconds !== null) {
    form.set("ttlSeconds", String(options.ttlSeconds));
  }

  const response = await fetch(`${options.endpoint}/api/publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  const payload = await readJsonResponse<PublishResponse>(response);
  await upsertReceipt({
    endpoint: options.endpoint,
    id: payload.id,
    url: payload.url,
    rawUrl: toRawUrl(payload.url),
    filePath: absoluteFilePath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: payload.revision ?? 1,
    contentSha256: payload.contentSha256 ?? null,
    attributes: payload.attributes ?? attributes,
  });
  let verification: VerificationResult | null = null;

  if (options.verify) {
    try {
      verification = await verifyArtifactContent({
        endpoint: options.endpoint,
        filePath: options.filePath,
        id: payload.id,
        json: false,
        url: payload.url,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(
        `Published ${payload.url}, but verification failed: ${reason} The receipt was saved; run pagebin show ${options.filePath} to recover the URL.`,
      );
    }
  }

  if (!output) {
    return payload;
  }

  if (options.json) {
    console.log(JSON.stringify(withSchema(verification ? { ...payload, verification } : payload), null, 2));
    return payload;
  }

  console.log(payload.url);

  if (verification) {
    console.error(`Verified revision ${verification.revision ?? "unknown"} (${verification.localSha256}).`);
  }
  return payload;
}

async function verifyArtifact(options: VerifyOptions): Promise<void> {
  const result = await verifyArtifactContent(options);

  if (options.json) {
    console.log(JSON.stringify(withSchema(result), null, 2));
    return;
  }

  console.log(`Verified ${result.id} (${result.localSha256}).`);
}

async function verifyArtifactContent(options: VerifyOptions): Promise<VerificationResult> {
  const upload = await readUploadFile(options.filePath);
  const localSha256 = await sha256Bytes(upload.bytes);

  if (options.url) {
    const rawUrl = toRawUrl(options.url);
    const response = await fetch(rawUrl, {
      headers: {
        Accept: "text/html",
        "Accept-Encoding": "identity",
      },
    });

    if (!response.ok) {
      throw new CliError(`Raw verification request failed with ${response.status}.`);
    }

    const remoteBytes = new TextEncoder().encode(await response.text());
    const remoteSha256 = await sha256Bytes(remoteBytes);

    assertMatchingContent(localSha256, remoteSha256, options.id);

    return {
      verified: true,
      method: "raw",
      id: options.id,
      url: rawUrl,
      localSha256,
      remoteSha256,
      size: remoteBytes.byteLength,
      revision: null,
    };
  }

  const token = readPublishToken();
  const response = await fetch(`${options.endpoint}/api/artifacts/${encodeURIComponent(options.id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const artifact = await readJsonResponse<ArtifactDetailResponse>(response);

  if (!artifact.contentSha256) {
    throw new CliError("This legacy artifact has no stored content hash; update or reissue it before verifying by ID.");
  }

  assertMatchingContent(localSha256, artifact.contentSha256, options.id);

  return {
    verified: true,
    method: "metadata",
    id: options.id,
    url: null,
    localSha256,
    remoteSha256: artifact.contentSha256,
    size: artifact.size,
    revision: artifact.revision,
  };
}

function assertMatchingContent(localSha256: string, remoteSha256: string, id: string): void {
  if (localSha256 !== remoteSha256) {
    throw new CliError(`Artifact ${id} does not match the local file (local ${localSha256}, remote ${remoteSha256}).`);
  }
}

function toRawUrl(value: string): string {
  const url = new URL(value);

  url.pathname = url.pathname.replace(/^\/p\//, "/raw/");
  return url.toString();
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function updateArtifact(options: UpdateOptions, output = true): Promise<UpdateResponse> {
  const resolvedOptions = options.receiptLookup ? await resolveUpdateReceipt(options) : options;
  const token = readPublishToken();
  const upload = await createHtmlUploadForm(resolvedOptions.filePath);
  const attributes = await resolveArtifactAttributes(resolvedOptions.filePath, resolvedOptions.attributes, resolvedOptions.inferMetadata);
  setArtifactAttributes(upload.form, attributes);
  const response = await fetch(`${resolvedOptions.endpoint}/api/artifacts/${encodeURIComponent(resolvedOptions.id)}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: upload.form,
  });
  const payload = await readJsonResponse<UpdateResponse>(response);

  await updateReceiptAfterContent(resolvedOptions, payload, attributes);

  warnIfStrictMarkdownUpdate(upload.sourceKind, payload.sandbox);

  if (!output) {
    return payload;
  }

  if (options.json) {
    console.log(JSON.stringify(withSchema({ ...payload, url: resolvedOptions.url }), null, 2));
    return payload;
  }

  console.log(resolvedOptions.url ?? payload.id);
  return payload;
}

async function watchArtifact(options: WatchOptions): Promise<void> {
  const watchedFile = resolve(options.filePath);
  const watchedDirectory = dirname(watchedFile);
  const watchedBasename = basename(watchedFile);

  let updateOptions: UpdateOptions | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let running = true;
  let pending = false;

  const runUpdate = (): void => {
    if (!updateOptions) {
      pending = true;
      return;
    }

    if (running) {
      pending = true;
      return;
    }

    running = true;
    updateArtifact({ ...updateOptions, json: false }, false)
      .then((payload) => {
        emitWatchEvent(options.json, "updated", { ...payload, url: updateOptions?.url ?? null });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        if (options.json) {
          console.log(JSON.stringify(withSchema({ event: "error", error: message })));
        } else {
          console.error(message);
        }
      })
      .finally(() => {
        running = false;

        if (pending) {
          pending = false;
          runUpdate();
        }
      });
  };

  const watcher = watch(watchedDirectory, (eventType, filename) => {
    if (eventType !== "rename" && filename && filename.toString() !== watchedBasename) {
      return;
    }

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(runUpdate, 250);
  });

  console.error(`Watching ${options.filePath}; press Ctrl-C to stop. Keep this process under tmux or another supervisor for long-running agent jobs.`);

  try {
    if (options.mode === "publish") {
      const receipt = await findReceiptByFile(options.endpoint, resolve(options.filePath));

      if (receipt) {
        updateOptions = {
          endpoint: options.endpoint,
          filePath: options.filePath,
          id: receipt.id,
          json: false,
          url: receipt.url,
          inferMetadata: options.inferMetadata,
          attributes: options.attributes,
          receiptLookup: false,
        };
        const payload = await updateArtifact(updateOptions, false);

        emitWatchEvent(options.json, "updated", { ...payload, url: updateOptions.url });
      } else {
        const payload = await publishArtifact({ ...options, json: false }, false);

        emitWatchEvent(options.json, "published", payload);

        updateOptions = {
          endpoint: options.endpoint,
          filePath: options.filePath,
          id: payload.id,
          json: false,
          url: payload.url,
          inferMetadata: options.inferMetadata,
          attributes: options.attributes,
          receiptLookup: false,
        };
      }
    } else {
      updateOptions = {
        endpoint: options.endpoint,
        filePath: options.filePath,
        id: options.id,
        json: false,
        url: options.url,
        inferMetadata: false,
        attributes: {},
        receiptLookup: false,
      };
      const payload = await updateArtifact(updateOptions, false);

      emitWatchEvent(options.json, "updated", { ...payload, url: updateOptions.url });
    }
  } catch (error) {
    watcher.close();
    throw error;
  }

  running = false;

  if (updateOptions) {
    await setWatchOwnership(updateOptions.endpoint, updateOptions.id, {
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
  }

  if (pending) {
    pending = false;
    runUpdate();
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      watcher.close();
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  if (updateOptions) {
    await setWatchOwnership(updateOptions.endpoint, updateOptions.id, null);
  }
}

function emitWatchEvent(json: boolean, event: "published" | "updated", payload: object): void {
  if (json) {
    console.log(JSON.stringify(withSchema({ event, ...payload })));
    return;
  }

  if (event === "published" && "url" in payload && typeof payload.url === "string") {
    console.log(payload.url);
    return;
  }

  if (event === "updated" && "url" in payload) {
    const value = typeof payload.url === "string" ? payload.url : "id" in payload ? String(payload.id) : "updated";
    console.log(value);
  }
}

async function createHtmlUploadForm(filePath: string): Promise<{ form: FormData; sourceKind: UploadSourceKind }> {
  const upload = await readUploadFile(filePath);
  const form = new FormData();

  form.set("file", new Blob([upload.bytes], { type: "text/html; charset=utf-8" }), upload.uploadFilename);
  form.set("filename", upload.displayFilename);

  return { form, sourceKind: upload.sourceKind };
}

function setArtifactAttributes(form: FormData, attributes: ArtifactAttributes): void {
  if (Object.keys(attributes).length > 0) {
    form.set("attributes", JSON.stringify(attributes));
  }
}

async function resolveArtifactAttributes(
  filePath: string,
  overrides: ArtifactAttributes,
  inferMetadata: boolean,
): Promise<ArtifactAttributes> {
  if (!inferMetadata) {
    return overrides;
  }

  const absolutePath = resolve(filePath);
  const repositoryRoot = runGit(dirname(absolutePath), ["rev-parse", "--show-toplevel"]);
  const inferred: ArtifactAttributes = {
    sourceHost: hostname(),
    artifactType: inferArtifactType(absolutePath),
    status: "active",
  };
  const title = await inferArtifactTitle(absolutePath);
  const agent = inferAgent();

  if (title) {
    inferred.title = title;
  }

  if (agent) {
    inferred.agent = agent;
  }

  if (repositoryRoot) {
    inferred.project = basename(repositoryRoot);
    const repo = runGit(repositoryRoot, ["remote", "get-url", "origin"]);
    const gitBranch = runGit(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const gitCommit = runGit(repositoryRoot, ["rev-parse", "HEAD"]);

    if (repo) {
      inferred.repo = sanitizeRepositoryRemote(repo);
    }

    if (gitBranch) {
      inferred.gitBranch = gitBranch;
    }

    if (gitCommit) {
      inferred.gitCommit = gitCommit;
    }

    inferred.sourcePath = relative(repositoryRoot, absolutePath);
  } else {
    inferred.sourcePath = basename(absolutePath);
  }

  return compactAttributes({ ...inferred, ...overrides });
}

function runGit(directory: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });

  if (result.exitCode !== 0) {
    return null;
  }

  const output = new TextDecoder().decode(result.stdout).trim();
  return output || null;
}

async function inferArtifactTitle(filePath: string): Promise<string | undefined> {
  let source: string;

  try {
    source = decodeUtf8(await readFile(filePath), "Artifact files must be valid UTF-8 text.");
  } catch {
    return undefined;
  }

  if (isMarkdownFile(filePath)) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
    const frontmatterTitle = frontmatter?.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    const heading = source.match(/^#\s+(.+)$/m)?.[1]?.trim();

    return frontmatterTitle || heading || undefined;
  }

  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const candidate = title || heading;

  return candidate ? candidate.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined : undefined;
}

function inferArtifactType(filePath: string): ArtifactType {
  const value = filePath.toLowerCase();

  if (value.includes("implementation-log") || value.includes("implementation_log")) {
    return "implementation-log";
  }

  if (value.includes("review")) {
    return "review";
  }

  if (value.includes("explainer") || value.includes("explanation")) {
    return "explainer";
  }

  if (value.includes("report") || value.includes("audit")) {
    return "report";
  }

  if (value.includes("plan")) {
    return "plan";
  }

  return "other";
}

export function sanitizeRepositoryRemote(value: string): string {
  try {
    const url = new URL(value);

    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }

    return url.toString();
  } catch {
    return value;
  }
}

function inferAgent(): string | undefined {
  if (process.env.PAGEBIN_AGENT?.trim()) {
    return process.env.PAGEBIN_AGENT.trim();
  }

  if (process.env.CODEX_HOME) {
    return "codex";
  }

  if (process.env.CLAUDE_CODE || process.env.CLAUDECODE) {
    return "claude-code";
  }

  return undefined;
}

function compactAttributes(attributes: ArtifactAttributes): ArtifactAttributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined && value !== "")) as ArtifactAttributes;
}

interface HtmlUpload {
  bytes: Uint8Array;
  displayFilename: string;
  sourceKind: UploadSourceKind;
  uploadFilename: string;
}

async function readUploadFile(filePath: string): Promise<HtmlUpload> {
  const fileInfo = await stat(filePath);

  if (!fileInfo.isFile()) {
    throw new CliError(`${filePath} is not a file.`);
  }

  const extension = extname(filePath).toLowerCase();

  if (extension !== HTML_EXTENSION && !MARKDOWN_EXTENSIONS.has(extension)) {
    throw new CliError("pagebin only accepts .html, .md, or .markdown files.");
  }

  if (fileInfo.size > DEFAULT_MAX_BYTES) {
    throw new CliError("File is larger than the 10 MB upload limit.");
  }

  const bytes = await readFile(filePath);

  if (extension === HTML_EXTENSION) {
    return {
      bytes,
      displayFilename: basename(filePath),
      sourceKind: "html",
      uploadFilename: basename(filePath),
    };
  }

  const markdown = decodeUtf8(bytes, "Markdown files must be valid UTF-8 text.");
  const html = renderMarkdownDocument(markdown, basename(filePath));
  const htmlBytes = new TextEncoder().encode(html);

  if (htmlBytes.byteLength > DEFAULT_MAX_BYTES) {
    throw new CliError("Rendered Markdown HTML is larger than the 10 MB upload limit.");
  }

  return {
    bytes: htmlBytes,
    displayFilename: basename(filePath),
    sourceKind: "markdown",
    uploadFilename: `${basename(filePath, extension)}.html`,
  };
}

function assertSandboxSupportsFile(filePath: string, sandbox: SandboxMode): void {
  if (sandbox === "strict" && isMarkdownFile(filePath)) {
    throw new CliError("Markdown rendering requires --sandbox standard because it uses client-side scripts.");
  }
}

function warnIfStrictMarkdownUpdate(sourceKind: UploadSourceKind, sandbox: SandboxMode): void {
  if (sourceKind === "markdown" && sandbox === "strict") {
    console.error("Warning: this Markdown upload was applied to a strict-sandbox artifact, so scripts will not run in the viewer.");
  }
}

function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isSupportedArtifactFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === HTML_EXTENSION || MARKDOWN_EXTENSIONS.has(extension);
}

function decodeUtf8(bytes: Uint8Array, errorMessage: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new CliError(errorMessage);
  }
}

async function deleteArtifact(options: DeleteOptions): Promise<void> {
  const token = readPublishToken();
  const response = await fetch(`${options.endpoint}/api/artifacts/${encodeURIComponent(options.id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 404) {
    await removeReceipt(options.endpoint, options.id);
    throw new CliError(`Artifact ${options.id} was not found; its stale local receipt was removed.`);
  }

  const payload = await readJsonResponse<DeleteResponse>(response);
  await removeReceipt(options.endpoint, options.id);

  if (options.json) {
    console.log(JSON.stringify(withSchema(payload), null, 2));
    return;
  }
}

async function reissueArtifact(options: ReissueOptions): Promise<void> {
  const token = readPublishToken();
  const response = await fetch(`${options.endpoint}/api/artifacts/${encodeURIComponent(options.id)}/reissue`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await readJsonResponse<ReissueResponse>(response);
  await updateReceiptUrl(options.endpoint, options.id, payload.url, payload.revision);

  if (options.json) {
    console.log(JSON.stringify(withSchema(payload), null, 2));
    return;
  }

  console.log(payload.url);
}

async function listArtifacts(options: ListOptions): Promise<void> {
  const token = readPublishToken();
  const response = await fetch(`${options.endpoint}/api/artifacts`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await readJsonResponse<ListResponse>(response);

  if (options.json) {
    console.log(JSON.stringify(withSchema(payload), null, 2));
    return;
  }

  console.log(formatArtifactList(payload.artifacts));
}

async function listReceipts(options: ReceiptListOptions): Promise<void> {
  const store = await readReceiptStore();

  if (options.json) {
    console.log(JSON.stringify(withSchema({ artifacts: store.artifacts }), null, 2));
    return;
  }

  if (store.artifacts.length === 0) {
    console.log("No local publication receipts.");
    return;
  }

  for (const receipt of store.artifacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    console.log(`${receipt.id}\t${receipt.attributes.title ?? basename(receipt.filePath)}\t${receipt.url ?? "URL unavailable"}`);
  }
}

async function showReceipt(options: ShowOptions): Promise<void> {
  const store = await readReceiptStore();
  const absoluteTarget = resolve(options.target);
  const targetId = isArtifactTargetLike(options.target) ? parseArtifactTarget(options.target).id : options.target;
  const receipt = store.artifacts
    .filter(
      (candidate) => candidate.id === targetId || candidate.filePath === absoluteTarget || candidate.url === options.target || candidate.rawUrl === options.target,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  if (!receipt) {
    throw new CliError(`No local PageBin receipt matches ${options.target}.`);
  }

  if (options.json) {
    console.log(JSON.stringify(withSchema(receipt), null, 2));
    return;
  }

  console.log(receipt.url ?? `Artifact ${receipt.id} has no recoverable local URL.`);
}

async function findReceiptByFile(endpoint: string, filePath: string): Promise<ArtifactReceipt | null> {
  const store = await readReceiptStore();
  return store.artifacts
    .filter((receipt) => receipt.endpoint === endpoint && receipt.filePath === filePath)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

async function resolveUpdateReceipt(options: UpdateOptions): Promise<UpdateOptions> {
  const receipt = await findReceiptByFile(options.endpoint, resolve(options.filePath));

  if (!receipt) {
    throw new CliError(`No local PageBin receipt exists for ${options.filePath}. Publish it first or provide an artifact ID or viewer URL.`);
  }

  return {
    ...options,
    id: receipt.id,
    url: receipt.url,
    receiptLookup: false,
  };
}

async function upsertReceipt(receipt: ArtifactReceipt): Promise<void> {
  await mutateReceiptStore((store) => {
    store.artifacts = store.artifacts.filter(
      (candidate) => candidate.endpoint !== receipt.endpoint || candidate.id !== receipt.id,
    );
    store.artifacts.push(receipt);
  });
}

async function updateReceiptAfterContent(
  options: UpdateOptions,
  payload: UpdateResponse,
  attributes: ArtifactAttributes,
): Promise<void> {
  await mutateReceiptStore((store) => {
    const existing = store.artifacts.find((receipt) => receipt.endpoint === options.endpoint && receipt.id === options.id);
    const now = new Date().toISOString();
    const url = options.url ?? existing?.url ?? null;
    const receipt: ArtifactReceipt = {
      endpoint: options.endpoint,
      id: options.id,
      url,
      rawUrl: url ? toRawUrl(url) : null,
      filePath: resolve(options.filePath),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revision: payload.revision ?? existing?.revision ?? 1,
      contentSha256: payload.contentSha256 ?? existing?.contentSha256 ?? null,
      attributes: payload.attributes ?? { ...existing?.attributes, ...attributes },
      ...(existing?.watch ? { watch: existing.watch } : {}),
    };

    store.artifacts = store.artifacts.filter(
      (candidate) => candidate.endpoint !== receipt.endpoint || candidate.id !== receipt.id,
    );
    store.artifacts.push(receipt);
  });
}

async function updateReceiptUrl(endpoint: string, id: string, url: string, revision: number): Promise<void> {
  await mutateReceiptStore((store) => {
    const receipt = store.artifacts.find((candidate) => candidate.endpoint === endpoint && candidate.id === id);

    if (receipt) {
      receipt.url = url;
      receipt.rawUrl = toRawUrl(url);
      receipt.updatedAt = new Date().toISOString();
      receipt.revision = revision ?? receipt.revision;
    }
  });
}

async function removeReceipt(endpoint: string, id: string): Promise<void> {
  await mutateReceiptStore((store) => {
    store.artifacts = store.artifacts.filter((receipt) => receipt.endpoint !== endpoint || receipt.id !== id);
  });
}

async function setWatchOwnership(endpoint: string, id: string, watch: WatchOwnership | null): Promise<void> {
  await mutateReceiptStore((store) => {
    const receipt = store.artifacts.find((candidate) => candidate.endpoint === endpoint && candidate.id === id);

    if (!receipt) {
      return;
    }

    if (watch) {
      receipt.watch = watch;
    } else {
      delete receipt.watch;
    }
  });
}

function describeActiveWatcher(receipt: ArtifactReceipt): string {
  if (!receipt.watch) {
    return "";
  }

  if (receipt.watch.host !== hostname()) {
    return ` and receipt metadata reports an active watcher on ${receipt.watch.host}`;
  }

  try {
    process.kill(receipt.watch.pid, 0);
    return ` and is watched by PID ${receipt.watch.pid}`;
  } catch {
    return "";
  }
}

async function readReceiptStore(): Promise<ReceiptStore> {
  try {
    const value = JSON.parse(await readFile(receiptStorePath(), "utf8")) as Partial<ReceiptStore>;

    if (value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
      throw new CliError(`Invalid pagebin receipt store at ${receiptStorePath()}.`);
    }

    return value as ReceiptStore;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { schemaVersion: 1, artifacts: [] };
    }

    throw error;
  }
}

async function writeReceiptStore(store: ReceiptStore): Promise<void> {
  const path = receiptStorePath();
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function mutateReceiptStore(mutator: (store: ReceiptStore) => void): Promise<void> {
  const path = receiptStorePath();
  const lockPath = `${path}.lock`;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await acquireReceiptLock(lockPath);

  try {
    const store = await readReceiptStore();
    mutator(store);
    await writeReceiptStore(store);
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireReceiptLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      let lockAge: number;

      try {
        lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch (statError) {
        if (isNodeError(statError) && statError.code === "ENOENT") {
          continue;
        }

        throw statError;
      }

      if (lockAge > 60_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new CliError("Timed out waiting for the local PageBin receipt store lock.");
}

function receiptStorePath(): string {
  if (process.env.PAGEBIN_STATE_PATH?.trim()) {
    return resolve(process.env.PAGEBIN_STATE_PATH.trim());
  }

  const stateHome = process.env.XDG_STATE_HOME?.trim() || resolve(homedir(), ".local/state");
  return resolve(stateHome, "pagebin/artifacts.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatArtifactList(artifacts: ListedArtifact[]): string {
  if (artifacts.length === 0) {
    return "No stored pages.";
  }

  const rows = artifacts.map((artifact) => ({
    id: artifact.id,
    filename: artifact.filename,
    created: formatDate(artifact.createdAt),
    expires: artifact.expiresAt ? formatDate(artifact.expiresAt) : "never",
    isExpired: isExpired(artifact.expiresAt),
    sandbox: artifact.sandbox,
    size: formatBytes(artifact.size),
  }));
  const headers = {
    id: "ID",
    filename: "Filename",
    created: "Created",
    expires: "Expires",
    sandbox: "Sandbox",
    size: "Size",
  };
  const widths = {
    id: maxWidth(headers.id, rows.map((row) => row.id)),
    filename: maxWidth(headers.filename, rows.map((row) => row.filename)),
    created: maxWidth(headers.created, rows.map((row) => row.created)),
    expires: maxWidth(headers.expires, rows.map((row) => row.expires)),
    sandbox: maxWidth(headers.sandbox, rows.map((row) => row.sandbox)),
    size: maxWidth(headers.size, rows.map((row) => row.size)),
  };
  const lines = [
    [
      headers.id.padEnd(widths.id),
      headers.filename.padEnd(widths.filename),
      headers.created.padEnd(widths.created),
      headers.expires.padEnd(widths.expires),
      headers.sandbox.padEnd(widths.sandbox),
      headers.size.padStart(widths.size),
    ].join("  "),
  ];

  for (const row of rows) {
    lines.push(
      [
        row.id.padEnd(widths.id),
        row.filename.padEnd(widths.filename),
        row.created.padEnd(widths.created),
        colorExpired(row.expires.padEnd(widths.expires), row.isExpired),
        row.sandbox.padEnd(widths.sandbox),
        row.size.padStart(widths.size),
      ].join("  "),
    );
  }

  return lines.join("\n");
}

function maxWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}

function formatDate(value: string): string {
  return value.replace(/\.\d{3}Z$/, "Z");
}

function isExpired(value: string | null): boolean {
  return value !== null && Date.now() >= Date.parse(value);
}

function colorExpired(value: string, isExpiredValue: boolean): string {
  if (!isExpiredValue || !shouldUseColor()) {
    return value;
  }

  return `${RED}${value}${RESET}`;
}

function shouldUseColor(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new CliError(`Server returned ${response.status}: ${text}`);
  }

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : text;
    throw new CliError(`Server returned ${response.status}: ${message}`);
  }

  return payload as T;
}

function readPublishToken(): string {
  const token = process.env.PAGEBIN_PUBLISH_TOKEN?.trim();

  if (!token) {
    throw new CliError("PAGEBIN_PUBLISH_TOKEN is required.");
  }

  return token;
}

function withSchema<T extends object>(payload: T): T & { schemaVersion: number } {
  return { schemaVersion: OUTPUT_SCHEMA_VERSION, ...payload };
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isArtifactId(value: string): boolean {
  return ARTIFACT_ID_PATTERN.test(value);
}

function isArtifactTargetLike(value: string): boolean {
  if (isArtifactId(value)) {
    return true;
  }

  try {
    const url = new URL(value);
    return url.pathname.startsWith("/p/") || url.pathname.startsWith("/raw/");
  } catch {
    return false;
  }
}

function isHelpFlag(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

function isHelpTopic(value: string): value is HelpTopic {
  return value === "publish" || value === "list" || value === "reissue" || value === "update" || value === "watch" || value === "verify" || value === "receipts" || value === "show" || value === "delete" || value === "version";
}

function helpText(topic: HelpTopic | null = null): string {
  switch (topic) {
    case "publish":
      return `pagebin publish

Uploads one local .html, .md, or .markdown file and prints a protected viewer URL.

Usage:
  pagebin publish <file.html|file.md|file.markdown> [metadata options] [--ttl 7d] [--sandbox standard|strict] [--verify] [--json] [--endpoint URL]

Options:
  --ttl 7d             Sets an expiration; supported units are s, m, h, d, w.
  --sandbox standard   Default. Allows scripts/forms/popups/downloads, but not same-origin.
  --sandbox strict     Disables iframe sandbox permissions; Markdown requires standard.
  --verify             Fetches the uploaded raw content and verifies its SHA-256 hash.
  --force-new          Intentionally creates another artifact for a file with a local receipt.
  --no-infer           Disables repository, host, title, type, and status inference.
  --title/--project    Override inferred metadata. See README for every metadata option.
  --json               Prints id, url, expiresAt, and sandbox as JSON.
  --endpoint URL       Worker endpoint. Defaults to PAGEBIN_ENDPOINT.
  -h, --help           Show this help.
`;
    case "list":
      return `pagebin list

Lists stored artifacts. Viewer URLs are not shown because view tokens are not stored.

Usage:
  pagebin list [--json] [--endpoint URL]

Options:
  --json               Prints artifacts as JSON.
  --endpoint URL       Worker endpoint. Defaults to PAGEBIN_ENDPOINT.
  -h, --help           Show this help.
`;
    case "reissue":
      return `pagebin reissue

Generates a new viewer URL for an artifact and revokes the old URL.

Usage:
  pagebin reissue <artifact_id> [--json] [--endpoint URL]

Options:
  --json               Prints id, url, expiresAt, and sandbox as JSON.
  --endpoint URL       Worker endpoint. Defaults to PAGEBIN_ENDPOINT.
  -h, --help           Show this help.
`;
    case "update":
      return `pagebin update

Replaces an artifact's content while preserving existing viewer URLs.

Usage:
  pagebin update <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--json] [--endpoint URL]
  pagebin update <file.html|file.md|file.markdown> [--json] [--endpoint URL]

Options:
  --json               Prints id, filename, dates, sandbox, size, and url as JSON.
  --endpoint URL       Worker endpoint. Inferred from viewer_url when omitted.
  -h, --help           Show this help.
`;
    case "watch":
      return `pagebin watch

Publishes a file and keeps updating it, or watches a file for an existing artifact.

Usage:
  pagebin watch <file.html|file.md|file.markdown> [--ttl 7d] [--sandbox standard|strict] [--json] [--endpoint URL]
  pagebin watch <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--json] [--endpoint URL]

Options:
  --ttl 7d             Sets an expiration for publish-then-watch mode only.
  --sandbox standard   Default for publish-then-watch mode.
  --sandbox strict     Publish-then-watch HTML only; Markdown requires standard.
  --json               Emits versioned JSON Lines publish, update, and error events.
  --endpoint URL       Worker endpoint. Inferred from viewer_url when omitted.
  -h, --help           Show this help.
`;
    case "verify":
      return `pagebin verify

Verifies that a local HTML or rendered Markdown file matches a stored artifact.

Usage:
  pagebin verify <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--json] [--endpoint URL]

Options:
  --json               Prints the verification method, hashes, size, and revision as JSON.
  --endpoint URL       Worker endpoint. Inferred from viewer_url when omitted.
  -h, --help           Show this help.
`;
    case "receipts":
      return `pagebin receipts

Lists protected local publication receipts, including recoverable viewer URLs.

Usage:
  pagebin receipts [--json]
`;
    case "show":
      return `pagebin show

Finds a local receipt by artifact ID, viewer URL, or source file and prints its URL.

Usage:
  pagebin show <artifact_id|viewer_url|file> [--json]
`;
    case "delete":
      return `pagebin delete

Deletes an artifact by id.

Usage:
  pagebin delete <artifact_id> [--json] [--endpoint URL]

Options:
  --json               Prints id and deleted status as JSON.
  --endpoint URL       Worker endpoint. Defaults to PAGEBIN_ENDPOINT.
  -h, --help           Show this help.
`;
    case "version":
      return `pagebin version

Prints the pagebin CLI version.

Usage:
  pagebin version
  pagebin --version
  pagebin -v
`;
    case null:
      break;
  }

  return `pagebin

Securely publish local .html and Markdown artifacts to a Cloudflare Worker/R2 backend and print a protected, unlisted viewer URL.
Use it for temporary agent-generated reports, plans, visual explanations, and previews.

Usage:
  pagebin publish <file.html|file.md|file.markdown> [metadata options] [--ttl 7d] [--sandbox standard|strict] [--verify] [--json] [--endpoint URL]
  pagebin list [--json] [--endpoint URL]
  pagebin reissue <artifact_id> [--json] [--endpoint URL]
  pagebin update <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--json] [--endpoint URL]
  pagebin watch <file.html|file.md|file.markdown> [--ttl 7d] [--sandbox standard|strict] [--endpoint URL]
  pagebin watch <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--endpoint URL]
  pagebin verify <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--json] [--endpoint URL]
  pagebin receipts [--json]
  pagebin show <artifact_id|viewer_url|file> [--json]
  pagebin delete <artifact_id> [--json] [--endpoint URL]
  pagebin version
  pagebin <command> --help

Behavior:
  publish              Uploads one .html file, or renders one Markdown file to HTML first.
  --json               Prints id, url, expiresAt, and sandbox as JSON.
  --ttl 7d             Sets an expiration; supported units are s, m, h, d, w.
  --sandbox standard   Default. Allows scripts/forms/popups/downloads, but not same-origin.
  --sandbox strict     Disables iframe sandbox permissions; Markdown requires standard.
  list                 Lists stored pages by id, filename, dates, sandbox, and size.
  reissue              Generates a new viewer URL for an artifact and revokes the old URL.
  update               Replaces an artifact's content while preserving existing viewer URLs.
  watch                Publishes a file, then updates that artifact whenever the file changes.
  verify               Compares the local rendered bytes with raw content or the stored hash.
  receipts             Lists protected local publication receipts.
  show                 Recovers a viewer URL from a local receipt.
  delete               Deletes an artifact by id; requires PAGEBIN_PUBLISH_TOKEN.

Environment:
  PAGEBIN_ENDPOINT        Worker endpoint, for example https://pagebin.example.workers.dev
  PAGEBIN_PUBLISH_TOKEN  Publisher token shared with the Worker
`;
}

if (import.meta.main) {
  await main();
}
