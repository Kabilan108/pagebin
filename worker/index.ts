interface Env {
  ARTIFACTS: R2Bucket;
  PAGEBIN_MAX_BYTES?: string;
  PAGEBIN_PUBLISH_TOKEN: string;
}

interface ArtifactMetadata {
  id: string;
  filename: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  size: number;
}

interface PublishPayload {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
}

type SandboxMode = "standard" | "strict";

interface UploadedFile {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const STANDARD_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: "Internal server error." }, 500);
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return text("User-agent: *\nDisallow: /\n", 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  }

  if (request.method === "POST" && url.pathname === "/api/publish") {
    return publish(request, env);
  }

  const deleteMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);

  if (request.method === "DELETE" && deleteMatch?.[1]) {
    return deleteArtifact(request, env, deleteMatch[1]);
  }

  const viewerMatch = url.pathname.match(/^\/p\/([^/]+)\/([^/]+)$/);

  if (request.method === "GET" && viewerMatch?.[1] && viewerMatch[2]) {
    return serveViewer(env, request.url, viewerMatch[1], viewerMatch[2]);
  }

  const rawMatch = url.pathname.match(/^\/raw\/([^/]+)\/([^/]+)$/);

  if (request.method === "GET" && rawMatch?.[1] && rawMatch[2]) {
    return serveRaw(env, rawMatch[1], rawMatch[2]);
  }

  return notFound();
}

async function publish(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  const maxBytes = readMaxBytes(env);
  const contentLength = readContentLength(request);

  if (contentLength !== null && contentLength > maxBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
    return json({ error: "Upload request is larger than the configured upload limit." }, 413);
  }

  const formResult = await readMultipartForm(request);

  if ("error" in formResult) {
    return json({ error: formResult.error }, formResult.status);
  }

  const form = formResult.form;
  const file = form.get("file");
  const parsedOptions = parsePublishOptions(form);

  if ("error" in parsedOptions) {
    return json({ error: parsedOptions.error }, 400);
  }

  if (!isUploadedFile(file)) {
    return json({ error: "Missing file upload." }, 400);
  }

  if (!file.name.toLowerCase().endsWith(".html")) {
    return json({ error: "Only .html files are accepted." }, 400);
  }

  if (file.size > maxBytes) {
    return json({ error: "File is larger than the configured upload limit." }, 413);
  }

  const html = await readUtf8File(file);

  if (html === null) {
    return json({ error: "Uploaded HTML must be valid UTF-8 text." }, 400);
  }

  const id = randomBase64Url(16);
  const token = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt =
    parsedOptions.ttlSeconds === null ? null : new Date(now.getTime() + parsedOptions.ttlSeconds * 1000).toISOString();
  const metadata: ArtifactMetadata = {
    id,
    filename: file.name,
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt,
    sandbox: parsedOptions.sandbox,
    size: file.size,
  };

  await env.ARTIFACTS.put(htmlKey(id), html, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8",
    },
  });

  try {
    await env.ARTIFACTS.put(metadataKey(id), JSON.stringify(metadata), {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    await env.ARTIFACTS.delete(htmlKey(id)).catch((cleanupError) => {
      console.error("Failed to clean up artifact after metadata write failure.", cleanupError);
    });
    throw error;
  }

  const payload: PublishPayload = {
    id,
    url: `${new URL(request.url).origin}/p/${id}/${token}`,
    expiresAt,
    sandbox: parsedOptions.sandbox,
  };

  return json(payload, 201);
}

async function deleteArtifact(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  if (!isValidId(id)) {
    return notFound();
  }

  await env.ARTIFACTS.delete(metadataKey(id));
  await env.ARTIFACTS.delete(htmlKey(id));

  return json({ id, deleted: true });
}

async function serveViewer(env: Env, requestUrl: string, id: string, token: string): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);

  if (!metadata) {
    return notFound();
  }

  const url = new URL(requestUrl);
  const rawPath = `/raw/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
  const sandbox = iframeSandboxAttribute(metadata.sandbox);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${escapeHtml(metadata.filename)}</title>
<style>
html,body{height:100%;margin:0;background:#fff}
iframe{display:block;width:100%;height:100%;border:0}
</style>
</head>
<body>
<iframe${sandbox} src="${escapeHtml(rawPath)}" title="${escapeHtml(metadata.filename)}"></iframe>
</body>
</html>`;

  return text(html, 200, {
    "Content-Security-Policy": "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    Link: `<${url.origin}/robots.txt>; rel="robots"`,
  });
}

async function serveRaw(env: Env, id: string, token: string): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);

  if (!metadata) {
    return notFound();
  }

  const object = await env.ARTIFACTS.get(htmlKey(id));

  if (!object) {
    return notFound();
  }

  return new Response(object.body, {
    status: 200,
    headers: secureHeaders({
      "Content-Security-Policy": rawSandboxCsp(metadata.sandbox),
      "Content-Type": "text/html; charset=utf-8",
    }),
  });
}

async function readAuthorizedMetadata(env: Env, id: string, token: string): Promise<ArtifactMetadata | null> {
  if (!isValidId(id) || !token) {
    return null;
  }

  const object = await env.ARTIFACTS.get(metadataKey(id));

  if (!object) {
    return null;
  }

  const metadata = JSON.parse(await object.text()) as ArtifactMetadata;

  if (metadata.expiresAt && Date.now() >= Date.parse(metadata.expiresAt)) {
    return null;
  }

  const tokenHash = await sha256Hex(token);

  if (!constantTimeEqual(tokenHash, metadata.tokenHash)) {
    return null;
  }

  return metadata;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match?.[1] || !env.PAGEBIN_PUBLISH_TOKEN) {
    return false;
  }

  const providedHash = await sha256Hex(match[1]);
  const expectedHash = await sha256Hex(env.PAGEBIN_PUBLISH_TOKEN);

  return constantTimeEqual(providedHash, expectedHash);
}

async function readMultipartForm(
  request: Request,
): Promise<{ form: FormData } | { error: string; status: 400 | 415 }> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return {
      error: "Publish requests must use multipart/form-data.",
      status: 415,
    };
  }

  try {
    return {
      form: await request.formData(),
    };
  } catch {
    return {
      error: "Invalid multipart form data.",
      status: 400,
    };
  }
}

function parsePublishOptions(form: FormData): { ttlSeconds: number | null; sandbox: SandboxMode } | { error: string } {
  try {
    return {
      sandbox: parseSandbox(form.get("sandbox")),
      ttlSeconds: parseOptionalPositiveInt(form.get("ttlSeconds")),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid publish options.",
    };
  }
}

function parseOptionalPositiveInt(value: unknown): number | null {
  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("TTL must be a positive integer number of seconds.");
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed > MAX_TTL_SECONDS) {
    throw new Error("TTL must be 10 years or less.");
  }

  return parsed;
}

function parseSandbox(value: unknown): SandboxMode {
  if (value === null || value === "") {
    return "standard";
  }

  if (value === "standard" || value === "strict") {
    return value;
  }

  throw new Error("Invalid sandbox mode.");
}

async function readUtf8File(file: UploadedFile): Promise<string | null> {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await file.arrayBuffer());
  } catch {
    return null;
  }
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "size" in value &&
    "arrayBuffer" in value &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.arrayBuffer === "function"
  );
}

function readMaxBytes(env: Env): number {
  const parsed = Number(env.PAGEBIN_MAX_BYTES ?? DEFAULT_MAX_BYTES);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BYTES;
  }

  return Math.min(parsed, DEFAULT_MAX_BYTES);
}

function readContentLength(request: Request): number | null {
  const value = request.headers.get("Content-Length");

  if (!value) {
    return DEFAULT_MAX_BYTES + MAX_MULTIPART_OVERHEAD_BYTES + 1;
  }

  if (!/^\d+$/.test(value)) {
    return DEFAULT_MAX_BYTES + MAX_MULTIPART_OVERHEAD_BYTES + 1;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_MAX_BYTES + MAX_MULTIPART_OVERHEAD_BYTES + 1;
  }

  return parsed;
}

function htmlKey(id: string): string {
  return `artifacts/${id}/index.html`;
}

function metadataKey(id: string): string {
  return `artifacts/${id}/metadata.json`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return base64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function iframeSandboxAttribute(mode: SandboxMode): string {
  if (mode === "strict") {
    return " sandbox";
  }

  return ` sandbox="${STANDARD_SANDBOX}"`;
}

function rawSandboxCsp(mode: SandboxMode): string {
  if (mode === "strict") {
    return "sandbox";
  }

  return `sandbox ${STANDARD_SANDBOX}`;
}

function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: secureHeaders({
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

function text(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: secureHeaders(headers),
  });
}

function notFound(): Response {
  return text("Not found.\n", 404, {
    "Content-Type": "text/plain; charset=utf-8",
  });
}

function secureHeaders(headers: HeadersInit = {}): Headers {
  const next = new Headers(headers);

  next.set("Cache-Control", "private, max-age=0, no-store");
  next.set("Referrer-Policy", "no-referrer");
  next.set("X-Content-Type-Options", "nosniff");
  next.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  next.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  return next;
}
