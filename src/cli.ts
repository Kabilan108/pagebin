#!/usr/bin/env bun

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import packageJson from "../package.json" with { type: "json" };

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SANDBOX = "standard";
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const VERSION = packageJson.version;

interface PublishResponse {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
}

interface DeleteResponse {
  id: string;
  deleted: boolean;
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

interface ParsedCommand {
  command: "publish" | "delete" | "help" | "version";
  options?: PublishOptions | DeleteOptions;
}

type SandboxMode = "standard" | "strict";

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

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
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
      case "version":
        console.log(VERSION);
        return;
      case "help":
        console.log(helpText());
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
    throw new CliError("publish requires a .html file path.");
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

    if (arg?.startsWith("-")) {
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

function readEndpoint(args: string[], env: NodeJS.ProcessEnv): string {
  const endpointIndex = args.indexOf("--endpoint");

  if (endpointIndex !== -1) {
    return requireValue(args[endpointIndex + 1], "--endpoint");
  }

  return env.PAGEBIN_ENDPOINT ?? "";
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

async function publishArtifact(options: PublishOptions): Promise<void> {
  const token = readPublishToken();
  const fileInfo = await stat(options.filePath);

  if (!fileInfo.isFile()) {
    throw new CliError(`${options.filePath} is not a file.`);
  }

  if (extname(options.filePath).toLowerCase() !== ".html") {
    throw new CliError("pagebin only accepts .html files.");
  }

  if (fileInfo.size > DEFAULT_MAX_BYTES) {
    throw new CliError("File is larger than the 10 MB upload limit.");
  }

  const bytes = await readFile(options.filePath);
  const form = new FormData();

  form.set("file", new Blob([bytes], { type: "text/html; charset=utf-8" }), basename(options.filePath));
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
    return;
  }

  console.log(payload.url);
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

function helpText(): string {
  return `pagebin

Usage:
  pagebin publish <file.html> [--ttl 7d] [--sandbox standard|strict] [--json] [--endpoint URL]
  pagebin delete <artifact_id> [--json] [--endpoint URL]
  pagebin version

Environment:
  PAGEBIN_ENDPOINT        Worker endpoint, for example https://pagebin.example.workers.dev
  PAGEBIN_PUBLISH_TOKEN  Publisher token shared with the Worker
`;
}

if (import.meta.main) {
  await main();
}
