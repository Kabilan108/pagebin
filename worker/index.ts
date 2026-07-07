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
  updatedAt: string;
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

interface ReissuePayload {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
}

interface UpdatePayload {
  id: string;
  filename: string;
  updatedAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  size: number;
}

interface VersionPayload {
  id: string;
  updatedAt: string;
  size: number;
}

interface ListedArtifact {
  id: string;
  filename: string;
  createdAt: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  size: number;
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

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await cleanupExpiredArtifacts(env);
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

  if (request.method === "GET" && url.pathname === "/api/artifacts") {
    return listArtifacts(request, env);
  }

  const updateMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);

  if (request.method === "PUT" && updateMatch?.[1]) {
    return updateArtifactContent(request, env, updateMatch[1]);
  }

  const reissueMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/reissue$/);

  if (request.method === "POST" && reissueMatch?.[1]) {
    return reissueArtifact(request, env, reissueMatch[1]);
  }

  const versionMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/version\/([^/]+)$/);

  if (request.method === "GET" && versionMatch?.[1] && versionMatch[2]) {
    return artifactVersion(env, versionMatch[1], versionMatch[2]);
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

  const upload = await readHtmlUpload(request, env);

  if ("error" in upload) {
    return json({ error: upload.error }, upload.status);
  }

  const parsedOptions = parsePublishOptions(upload.form);

  if ("error" in parsedOptions) {
    return json({ error: parsedOptions.error }, 400);
  }

  const id = randomBase64Url(16);
  const token = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt =
    parsedOptions.ttlSeconds === null ? null : new Date(now.getTime() + parsedOptions.ttlSeconds * 1000).toISOString();
  const metadata: ArtifactMetadata = {
    id,
    filename: upload.displayFilename,
    tokenHash,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt,
    sandbox: parsedOptions.sandbox,
    size: upload.file.size,
  };

  await env.ARTIFACTS.put(htmlKey(id), upload.html, {
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

async function updateArtifactContent(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  if (!isValidId(id)) {
    return notFound();
  }

  const object = await env.ARTIFACTS.get(metadataKey(id));

  if (!object) {
    return notFound();
  }

  const metadata = normalizeMetadata(JSON.parse(await object.text()) as ArtifactMetadata);

  if (metadata.expiresAt && Date.now() >= Date.parse(metadata.expiresAt)) {
    return json({ error: "Artifact has expired." }, 410);
  }

  const upload = await readHtmlUpload(request, env);

  if ("error" in upload) {
    return json({ error: upload.error }, upload.status);
  }

  const updatedAt = new Date().toISOString();
  const nextMetadata: ArtifactMetadata = {
    ...metadata,
    filename: upload.displayFilename,
    updatedAt,
    size: upload.file.size,
  };
  const previousHtml = await env.ARTIFACTS.get(htmlKey(id));
  const previousHtmlBytes = previousHtml ? await previousHtml.arrayBuffer() : null;

  await env.ARTIFACTS.put(htmlKey(id), upload.html, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8",
    },
  });

  try {
    await env.ARTIFACTS.put(metadataKey(id), JSON.stringify(nextMetadata), {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    if (previousHtmlBytes) {
      await env.ARTIFACTS.put(htmlKey(id), previousHtmlBytes, {
        httpMetadata: {
          contentType: "text/html; charset=utf-8",
        },
      });
    } else {
      await env.ARTIFACTS.delete(htmlKey(id));
    }

    throw error;
  }

  const payload: UpdatePayload = {
    id,
    filename: nextMetadata.filename,
    updatedAt,
    expiresAt: nextMetadata.expiresAt,
    sandbox: nextMetadata.sandbox,
    size: nextMetadata.size,
  };

  return json(payload);
}

async function listArtifacts(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  const artifacts: ListedArtifact[] = [];
  let cursor: string | undefined;

  do {
    const options: R2ListOptions = cursor ? { cursor, prefix: "artifacts/" } : { prefix: "artifacts/" };
    const result = await env.ARTIFACTS.list(options);

    cursor = result.truncated ? result.cursor : undefined;

    for (const object of result.objects) {
      if (!object.key.endsWith("/metadata.json")) {
        continue;
      }

      const metadata = await env.ARTIFACTS.get(object.key);

      if (!metadata) {
        continue;
      }

      const artifact = normalizeMetadata(JSON.parse(await metadata.text()) as ArtifactMetadata);

      artifacts.push({
        id: artifact.id,
        filename: artifact.filename,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
        sandbox: artifact.sandbox,
        size: artifact.size,
      });
    }
  } while (cursor);

  artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return json({ artifacts });
}

async function reissueArtifact(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  if (!isValidId(id)) {
    return notFound();
  }

  const object = await env.ARTIFACTS.get(metadataKey(id));

  if (!object) {
    return notFound();
  }

  const metadata = normalizeMetadata(JSON.parse(await object.text()) as ArtifactMetadata);

  if (metadata.expiresAt && Date.now() >= Date.parse(metadata.expiresAt)) {
    return json({ error: "Artifact has expired." }, 410);
  }

  const token = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const nextMetadata: ArtifactMetadata = {
    ...metadata,
    tokenHash,
  };

  await env.ARTIFACTS.put(metadataKey(id), JSON.stringify(nextMetadata), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
  });

  const payload: ReissuePayload = {
    id,
    url: `${new URL(request.url).origin}/p/${id}/${token}`,
    expiresAt: metadata.expiresAt,
    sandbox: metadata.sandbox,
  };

  return json(payload);
}

async function artifactVersion(env: Env, id: string, token: string): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);

  if (!metadata) {
    return notFound();
  }

  const payload: VersionPayload = {
    id: metadata.id,
    updatedAt: metadata.updatedAt,
    size: metadata.size,
  };

  return json(payload);
}

async function cleanupExpiredArtifacts(env: Env): Promise<void> {
  let cursor: string | undefined;

  do {
    const options: R2ListOptions = cursor ? { cursor, prefix: "artifacts/" } : { prefix: "artifacts/" };
    const result = await env.ARTIFACTS.list(options);

    cursor = result.truncated ? result.cursor : undefined;

    for (const object of result.objects) {
      if (!object.key.endsWith("/metadata.json")) {
        continue;
      }

      try {
        await cleanupExpiredArtifact(env, object.key);
      } catch (error) {
        console.error("Failed to clean up expired artifact.", object.key, error);
      }
    }
  } while (cursor);
}

async function cleanupExpiredArtifact(env: Env, key: string): Promise<void> {
  const object = await env.ARTIFACTS.get(key);

  if (!object) {
    return;
  }

  const metadata = normalizeMetadata(JSON.parse(await object.text()) as ArtifactMetadata);

  if (!metadata.expiresAt || Date.now() < Date.parse(metadata.expiresAt)) {
    return;
  }

  await env.ARTIFACTS.delete(htmlKey(metadata.id));
  await env.ARTIFACTS.delete(metadataKey(metadata.id));
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
  const versionPath = `/api/artifacts/${encodeURIComponent(id)}/version/${encodeURIComponent(token)}`;
  const sandbox = iframeSandboxAttribute(metadata.sandbox);
  const version = metadata.updatedAt;
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
<iframe id="pagebin-frame"${sandbox} src="${escapeHtml(rawPath)}" title="${escapeHtml(metadata.filename)}"></iframe>
<script>
const pagebinFrame = document.getElementById("pagebin-frame");
const pagebinMinDelayMs = 2000;
const pagebinMaxDelayMs = 60000;
let pagebinVersion = ${JSON.stringify(version)};
let pagebinDelayMs = pagebinMinDelayMs;
let pagebinTimer = null;
function pagebinSchedule() {
  clearTimeout(pagebinTimer);
  if (!document.hidden) {
    pagebinTimer = setTimeout(pagebinPoll, pagebinDelayMs);
  }
}
async function pagebinPoll() {
  let changed = false;
  try {
    const response = await fetch(${JSON.stringify(versionPath)}, { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      if (payload.updatedAt && payload.updatedAt !== pagebinVersion) {
        pagebinVersion = payload.updatedAt;
        pagebinFrame.src = ${JSON.stringify(rawPath)} + "?v=" + encodeURIComponent(pagebinVersion);
        changed = true;
      }
    }
  } catch {}
  pagebinDelayMs = changed ? pagebinMinDelayMs : Math.min(pagebinDelayMs * 1.5, pagebinMaxDelayMs);
  pagebinSchedule();
}
document.addEventListener("visibilitychange", () => {
  clearTimeout(pagebinTimer);
  if (!document.hidden) {
    pagebinDelayMs = pagebinMinDelayMs;
    pagebinPoll();
  }
});
pagebinSchedule();
</script>
</body>
</html>`;

  return text(html, 200, {
    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

  const metadata = normalizeMetadata(JSON.parse(await object.text()) as ArtifactMetadata);

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

async function readHtmlUpload(
  request: Request,
  env: Env,
): Promise<{ displayFilename: string; file: UploadedFile; form: FormData; html: string } | { error: string; status: 400 | 413 | 415 }> {
  const maxBytes = readMaxBytes(env);
  const contentLength = readContentLength(request);

  if (contentLength !== null && contentLength > maxBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
    return {
      error: "Upload request is larger than the configured upload limit.",
      status: 413,
    };
  }

  const formResult = await readMultipartForm(request);

  if ("error" in formResult) {
    return formResult;
  }

  const file = formResult.form.get("file");

  if (!isUploadedFile(file)) {
    return {
      error: "Missing file upload.",
      status: 400,
    };
  }

  if (!file.name.toLowerCase().endsWith(".html")) {
    return {
      error: "Only .html files are accepted.",
      status: 400,
    };
  }

  if (file.size > maxBytes) {
    return {
      error: "File is larger than the configured upload limit.",
      status: 413,
    };
  }

  const html = await readUtf8File(file);

  if (html === null) {
    return {
      error: "Uploaded HTML must be valid UTF-8 text.",
      status: 400,
    };
  }

  return {
    displayFilename: readDisplayFilename(formResult.form, file.name),
    file,
    form: formResult.form,
    html,
  };
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

function readDisplayFilename(form: FormData, fallback: string): string {
  const value = form.get("filename");

  if (typeof value !== "string") {
    return normalizeDisplayFilename(fallback);
  }

  return normalizeDisplayFilename(value) || normalizeDisplayFilename(fallback);
}

function normalizeDisplayFilename(value: string): string {
  const normalized = value.trim().replaceAll("\0", "").replaceAll("\\", "/");
  const filename = normalized
    .split("/")
    .filter((part) => part.length > 0)
    .at(-1);

  return filename?.slice(0, 255) ?? "";
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

function normalizeMetadata(metadata: ArtifactMetadata): ArtifactMetadata {
  return {
    ...metadata,
    updatedAt: metadata.updatedAt ?? metadata.createdAt,
  };
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
