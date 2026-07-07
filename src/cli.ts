#!/usr/bin/env bun

import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

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

interface PublishResponse {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
}

interface ReissueResponse {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
}

interface UpdateResponse {
  id: string;
  filename: string;
  updatedAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  size: number;
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
}

interface PublishOptions {
  endpoint: string;
  filePath: string;
  json: boolean;
  sandbox: SandboxMode;
  ttlSeconds: number | null;
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

interface HelpOptions {
  topic: HelpTopic | null;
}

interface ArtifactTarget {
  id: string;
  url: string | null;
  urlOrigin: string | null;
}

interface ParsedCommand {
  command: "publish" | "delete" | "reissue" | "update" | "watch" | "list" | "help" | "version";
  options?: PublishOptions | DeleteOptions | ReissueOptions | UpdateOptions | WatchOptions | ListOptions | HelpOptions;
}

type SandboxMode = "standard" | "strict";
type UploadSourceKind = "html" | "markdown";
type HelpTopic = Exclude<ParsedCommand["command"], "help">;

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

  if (!filePath) {
    throw new CliError("update requires a .html, .md, or .markdown file path.");
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

function parseWatchOptions(args: string[], env: NodeJS.ProcessEnv): WatchOptions {
  const values: string[] = [];
  let sandbox: SandboxMode = DEFAULT_SANDBOX;
  let sandboxProvided = false;
  let ttlProvided = false;
  let ttlSeconds: number | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      throw new CliError("watch does not support --json because it is a long-running command.");
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
      json: false,
      mode: "publish",
      sandbox,
      ttlSeconds,
    };
  }

  if (ttlProvided) {
    throw new CliError("--ttl can only be used with pagebin watch <file>.");
  }

  if (sandboxProvided) {
    throw new CliError("--sandbox can only be used with pagebin watch <file>.");
  }

  const [targetValue, filePath] = values;

  if (!targetValue || !filePath) {
    throw new CliError("watch accepts either one file path or one artifact target and one file path.");
  }

  const target = parseArtifactTarget(targetValue);
  const endpoint = normalizeEndpoint(readEndpointOption(args) ?? target.urlOrigin ?? env.PAGEBIN_ENDPOINT ?? "");

  return {
    endpoint,
    filePath,
    id: target.id,
    json: false,
    mode: "update",
    url: target.url,
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

function readEndpoint(args: string[], env: NodeJS.ProcessEnv): string {
  return readOptionalEndpoint(args, env) ?? "";
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

async function publishArtifact(options: PublishOptions): Promise<PublishResponse> {
  assertSandboxSupportsFile(options.filePath, options.sandbox);

  const token = readPublishToken();
  const { form } = await createHtmlUploadForm(options.filePath);

  form.set("sandbox", options.sandbox);

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

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  console.log(payload.url);
  return payload;
}

async function updateArtifact(options: UpdateOptions): Promise<UpdateResponse> {
  const token = readPublishToken();
  const upload = await createHtmlUploadForm(options.filePath);
  const response = await fetch(`${options.endpoint}/api/artifacts/${encodeURIComponent(options.id)}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: upload.form,
  });
  const payload = await readJsonResponse<UpdateResponse>(response);

  warnIfStrictMarkdownUpdate(upload.sourceKind, payload.sandbox);

  if (options.json) {
    console.log(JSON.stringify({ ...payload, url: options.url }, null, 2));
    return payload;
  }

  console.log(options.url ?? payload.id);
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
    updateArtifact({ ...updateOptions, json: false })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
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

  console.error(`Watching ${options.filePath}; press Ctrl-C to stop.`);

  try {
    if (options.mode === "publish") {
      const payload = await publishArtifact(options);

      updateOptions = {
        endpoint: options.endpoint,
        filePath: options.filePath,
        id: payload.id,
        json: false,
        url: payload.url,
      };
    } else {
      updateOptions = {
        endpoint: options.endpoint,
        filePath: options.filePath,
        id: options.id,
        json: false,
        url: options.url,
      };
      await updateArtifact(updateOptions);
    }
  } catch (error) {
    watcher.close();
    throw error;
  }

  running = false;

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
}

async function createHtmlUploadForm(filePath: string): Promise<{ form: FormData; sourceKind: UploadSourceKind }> {
  const upload = await readUploadFile(filePath);
  const form = new FormData();

  form.set("file", new Blob([upload.bytes], { type: "text/html; charset=utf-8" }), upload.uploadFilename);
  form.set("filename", upload.displayFilename);

  return { form, sourceKind: upload.sourceKind };
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

  const payload = await readJsonResponse<DeleteResponse>(response);

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
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

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
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
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(formatArtifactList(payload.artifacts));
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
  return value === "publish" || value === "list" || value === "reissue" || value === "update" || value === "watch" || value === "delete" || value === "version";
}

function helpText(topic: HelpTopic | null = null): string {
  switch (topic) {
    case "publish":
      return `pagebin publish

Uploads one local .html, .md, or .markdown file and prints a protected viewer URL.

Usage:
  pagebin publish <file.html|file.md|file.markdown> [--ttl 7d] [--sandbox standard|strict] [--json] [--endpoint URL]

Options:
  --ttl 7d             Sets an expiration; supported units are s, m, h, d, w.
  --sandbox standard   Default. Allows scripts/forms/popups/downloads, but not same-origin.
  --sandbox strict     Disables iframe sandbox permissions; Markdown requires standard.
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

Options:
  --json               Prints id, filename, dates, sandbox, size, and url as JSON.
  --endpoint URL       Worker endpoint. Inferred from viewer_url when omitted.
  -h, --help           Show this help.
`;
    case "watch":
      return `pagebin watch

Publishes a file and keeps updating it, or watches a file for an existing artifact.

Usage:
  pagebin watch <file.html|file.md|file.markdown> [--ttl 7d] [--sandbox standard|strict] [--endpoint URL]
  pagebin watch <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--endpoint URL]

Options:
  --ttl 7d             Sets an expiration for publish-then-watch mode only.
  --sandbox standard   Default for publish-then-watch mode.
  --sandbox strict     Publish-then-watch HTML only; Markdown requires standard.
  --endpoint URL       Worker endpoint. Inferred from viewer_url when omitted.
  -h, --help           Show this help.
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
  pagebin publish <file.html|file.md|file.markdown> [--ttl 7d] [--sandbox standard|strict] [--json] [--endpoint URL]
  pagebin list [--json] [--endpoint URL]
  pagebin reissue <artifact_id> [--json] [--endpoint URL]
  pagebin update <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--json] [--endpoint URL]
  pagebin watch <file.html|file.md|file.markdown> [--ttl 7d] [--sandbox standard|strict] [--endpoint URL]
  pagebin watch <artifact_id|viewer_url> <file.html|file.md|file.markdown> [--endpoint URL]
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
  delete               Deletes an artifact by id; requires PAGEBIN_PUBLISH_TOKEN.

Environment:
  PAGEBIN_ENDPOINT        Worker endpoint, for example https://pagebin.example.workers.dev
  PAGEBIN_PUBLISH_TOKEN  Publisher token shared with the Worker
`;
}

if (import.meta.main) {
  await main();
}
