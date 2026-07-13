interface Env {
  ARTIFACTS: R2Bucket;
  PAGEBIN_MAX_BYTES?: string;
  PAGEBIN_PUBLISH_TOKEN: string;
  PAGEBIN_PUBLIC_ORIGIN?: string;
  PAGEBIN_CAPABILITY_KEY?: string;
  PAGEBIN_CAPABILITY_KEY_VERSION?: string;
  PAGEBIN_ACCESS_TEAM_DOMAIN?: string;
  PAGEBIN_ACCESS_AUD?: string;
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
  revision: number;
  contentKey: string;
  contentSha256: string | null;
  deletedAt?: string;
  attributes: ArtifactAttributes;
  encryptedToken?: EncryptedViewerToken;
}

interface EncryptedViewerToken {
  ciphertext: string;
  iv: string;
  keyVersion: string;
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

interface PublishPayload {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  revision: number;
  contentSha256: string;
  attributes: ArtifactAttributes;
}

interface ReissuePayload {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  revision: number;
}

interface UpdatePayload {
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

interface VersionPayload {
  id: string;
  updatedAt: string;
  size: number;
  revision: number;
  contentSha256: string | null;
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

interface ArtifactDetail extends ListedArtifact {
  updatedAt: string;
}

interface StoredArtifactMetadata {
  metadata: ArtifactMetadata;
  etag: string;
}

type SandboxMode = "standard" | "strict";
type ArtifactType = "plan" | "report" | "review" | "explainer" | "implementation-log" | "other";
type ArtifactStatus = "draft" | "active" | "done" | "superseded" | "archived";

interface UploadedFile {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const ORPHAN_CONTENT_GRACE_MS = 60 * 60 * 1000;
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
  const hostname = url.hostname;

  if (isAdminHostname(hostname)) {
    const dashboardResponse = await routeDashboard(request, env, url, hostname);

    if (dashboardResponse) {
      return dashboardResponse;
    }

    if (hostname === "admin.page-bin.com") {
      return notFound();
    }
  }

  const publicVersionPath = /^\/api\/artifacts\/[^/]+\/version\/[^/]+$/.test(url.pathname);

  if (hostname === "page-bin.com" && url.pathname.startsWith("/api/") && !publicVersionPath) {
    return misdirected();
  }

  if (hostname === "api.page-bin.com" && (url.pathname === "/" || url.pathname.startsWith("/p/") || url.pathname.startsWith("/raw/"))) {
    return misdirected();
  }

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

  if (request.method === "GET" && deleteMatch?.[1]) {
    return getArtifact(request, env, deleteMatch[1]);
  }

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

async function routeDashboard(request: Request, env: Env, url: URL, hostname: string): Promise<Response | null> {
  const isDashboardPath = url.pathname === "/" || url.pathname.startsWith("/api/dashboard/") || url.pathname === "/api/dashboard/artifacts";

  if (!isDashboardPath) {
    return null;
  }

  if (!(await isDashboardAuthorized(request, env, hostname))) {
    return json({ error: "Unauthorized." }, 401);
  }

  if (request.method === "GET" && url.pathname === "/") {
    return serveDashboard();
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard/artifacts") {
    return dashboardArtifacts(env, url);
  }

  const linkMatch = url.pathname.match(/^\/api\/dashboard\/artifacts\/([^/]+)\/(link|open)$/);

  if (request.method === "GET" && linkMatch?.[1] && linkMatch[2]) {
    return dashboardArtifactLink(request, env, linkMatch[1], linkMatch[2] === "open");
  }

  const reissueMatch = url.pathname.match(/^\/api\/dashboard\/artifacts\/([^/]+)\/reissue$/);

  if (request.method === "POST" && reissueMatch?.[1]) {
    if (!hasDashboardMutationHeader(request)) {
      return json({ error: "Missing dashboard mutation header." }, 403);
    }
    return dashboardManagementRequest(request, env, reissueMatch[1], "reissue");
  }

  const artifactMatch = url.pathname.match(/^\/api\/dashboard\/artifacts\/([^/]+)$/);

  if (request.method === "DELETE" && artifactMatch?.[1]) {
    if (!hasDashboardMutationHeader(request)) {
      return json({ error: "Missing dashboard mutation header." }, 403);
    }
    return dashboardManagementRequest(request, env, artifactMatch[1], "delete");
  }

  return notFound();
}

function hasDashboardMutationHeader(request: Request): boolean {
  return request.headers.get("X-PageBin-Dashboard") === "1";
}

function isAdminHostname(hostname: string): boolean {
  return hostname === "admin.page-bin.com" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}


async function dashboardArtifacts(env: Env, url: URL): Promise<Response> {
  const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
  const project = url.searchParams.get("project")?.trim() ?? "";
  const sourceHost = url.searchParams.get("sourceHost")?.trim() ?? "";
  const status = url.searchParams.get("status")?.trim() ?? "";
  const artifacts = (await readAllArtifactMetadata(env))
    .filter((artifact) => {
      const haystack = [artifact.filename, artifact.attributes.title, artifact.attributes.project, artifact.attributes.sourceHost]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!search || haystack.includes(search)) &&
        (!project || artifact.attributes.project === project) &&
        (!sourceHost || artifact.attributes.sourceHost === sourceHost) &&
        (!status || artifact.attributes.status === status)
      );
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const page = artifacts.map((artifact) => ({
    id: artifact.id,
    filename: artifact.filename,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    expiresAt: artifact.expiresAt,
    sandbox: artifact.sandbox,
    size: artifact.size,
    revision: artifact.revision,
    contentSha256: artifact.contentSha256,
    attributes: artifact.attributes,
    linkRecoverable: Boolean(artifact.encryptedToken),
  }));
  const nextCursor = null;

  return json({ artifacts: page, nextCursor, total: artifacts.length });
}

async function dashboardArtifactLink(request: Request, env: Env, id: string, redirect: boolean): Promise<Response> {
  if (!isValidId(id)) {
    return notFound();
  }

  const stored = await readStoredMetadata(env, id);

  if (!stored || stored.metadata.deletedAt || !stored.metadata.encryptedToken) {
    return json({ error: "This artifact has no recoverable viewer URL. Reissue it first." }, 409);
  }

  const token = await decryptViewerToken(env, id, stored.metadata.encryptedToken);

  if (!token || !constantTimeEqual(await sha256Hex(token), stored.metadata.tokenHash)) {
    return json({ error: "The viewer URL could not be recovered. Reissue it to create a new link." }, 409);
  }

  const url = `${publicOrigin(request, env)}/p/${id}/${token}`;

  if (redirect) {
    return new Response(null, { status: 303, headers: secureHeaders({ Location: url }) });
  }

  return json({ id, url });
}

async function dashboardManagementRequest(
  request: Request,
  env: Env,
  id: string,
  action: "reissue" | "delete",
): Promise<Response> {
  const path = action === "reissue" ? `/api/artifacts/${encodeURIComponent(id)}/reissue` : `/api/artifacts/${encodeURIComponent(id)}`;
  const internalRequest = new Request(`${new URL(request.url).origin}${path}`, {
    method: action === "reissue" ? "POST" : "DELETE",
    headers: { Authorization: `Bearer ${env.PAGEBIN_PUBLISH_TOKEN}` },
  });

  return action === "reissue" ? reissueArtifact(internalRequest, env, id) : deleteArtifact(internalRequest, env, id);
}

async function readAllArtifactMetadata(env: Env): Promise<ArtifactMetadata[]> {
  const artifacts: ArtifactMetadata[] = [];
  let cursor: string | undefined;

  do {
    const options: R2ListOptions = cursor ? { cursor, prefix: "artifacts/" } : { prefix: "artifacts/" };
    const result = await env.ARTIFACTS.list(options);

    cursor = result.truncated ? result.cursor : undefined;

    for (const object of result.objects) {
      if (!object.key.endsWith("/metadata.json")) {
        continue;
      }

      const stored = await env.ARTIFACTS.get(object.key);

      if (!stored) {
        continue;
      }

      const metadata = normalizeMetadata(JSON.parse(await stored.text()) as ArtifactMetadata);

      if (!metadata.deletedAt) {
        artifacts.push(metadata);
      }
    }
  } while (cursor);

  return artifacts;
}

async function isDashboardAuthorized(request: Request, env: Env, hostname: string): Promise<boolean> {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  const teamDomain = env.PAGEBIN_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.PAGEBIN_ACCESS_AUD?.trim();
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? readCookie(request.headers.get("Cookie"), "CF_Authorization");

  if (!teamDomain || !audience || !token) {
    return false;
  }

  return validateAccessJwt(token, teamDomain, audience);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }

  for (const value of header.split(";")) {
    const [key, ...parts] = value.trim().split("=");

    if (key === name) {
      return parts.join("=") || null;
    }
  }

  return null;
}

async function validateAccessJwt(token: string, teamDomain: string, audience: string): Promise<boolean> {
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");

    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      return false;
    }

    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader))) as { alg?: string; kid?: string };
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as {
      aud?: string | string[];
      exp?: number;
      iat?: number;
      iss?: string;
      nbf?: number;
    };

    const now = Date.now() / 1000;
    const clockSkewSeconds = 60;

    if (
      header.alg !== "RS256" ||
      !header.kid ||
      !payload.exp ||
      payload.exp <= now - clockSkewSeconds ||
      (payload.nbf !== undefined && payload.nbf > now + clockSkewSeconds) ||
      (payload.iat !== undefined && payload.iat > now + clockSkewSeconds)
    ) {
      return false;
    }

    const expectedIssuer = `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];

    if (payload.iss?.replace(/\/$/, "") !== expectedIssuer || !audiences.includes(audience)) {
      return false;
    }

    const certsResponse = await fetch(`${expectedIssuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600, cacheEverything: true } });

    if (!certsResponse.ok) {
      return false;
    }

    const certs = (await certsResponse.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = certs.keys?.find((key) => key.kid === header.kid);

    if (!jwk) {
      return false;
    }

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);

    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch {
    return false;
  }
}

async function getArtifact(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  if (!isValidId(id)) {
    return notFound();
  }

  const stored = await readStoredMetadata(env, id);

  if (!stored || stored.metadata.deletedAt) {
    return notFound();
  }

  const metadata = stored.metadata;
  const payload: ArtifactDetail = {
    id: metadata.id,
    filename: metadata.filename,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    expiresAt: metadata.expiresAt,
    sandbox: metadata.sandbox,
    size: metadata.size,
    revision: metadata.revision,
    contentSha256: metadata.contentSha256,
    attributes: metadata.attributes,
  };

  return json(payload);
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
  const encryptedToken = await encryptViewerToken(env, id, token);
  const contentSha256 = await sha256Hex(upload.html);
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
    revision: 1,
    contentKey: htmlKey(id),
    contentSha256,
    attributes: parsedOptions.attributes,
    ...(encryptedToken ? { encryptedToken } : {}),
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
    url: `${publicOrigin(request, env)}/p/${id}/${token}`,
    expiresAt,
    sandbox: parsedOptions.sandbox,
    revision: metadata.revision,
    contentSha256,
    attributes: metadata.attributes,
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

  const stored = await readStoredMetadata(env, id);

  if (!stored || stored.metadata.deletedAt) {
    return notFound();
  }
  const { metadata } = stored;

  if (metadata.expiresAt && Date.now() >= Date.parse(metadata.expiresAt)) {
    return json({ error: "Artifact has expired." }, 410);
  }

  const upload = await readHtmlUpload(request, env);

  if ("error" in upload) {
    return json({ error: upload.error }, upload.status);
  }

  const updatedAt = new Date().toISOString();
  const revision = metadata.revision + 1;
  const contentSha256 = await sha256Hex(upload.html);
  const nextContentKey = versionedHtmlKey(id, revision);
  let attributes: ArtifactAttributes;

  try {
    attributes = parseArtifactAttributes(upload.form);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid artifact attributes." }, 400);
  }

  const nextMetadata: ArtifactMetadata = {
    ...metadata,
    filename: upload.displayFilename,
    updatedAt,
    size: upload.file.size,
    revision,
    contentKey: nextContentKey,
    contentSha256,
    attributes: {
      ...metadata.attributes,
      ...attributes,
    },
  };

  await env.ARTIFACTS.put(nextContentKey, upload.html, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8",
    },
  });

  try {
    const written = await writeMetadataIfMatch(env, id, nextMetadata, stored.etag);

    if (!written) {
      await env.ARTIFACTS.delete(nextContentKey).catch((cleanupError) => {
        console.error("Failed to clean up conflicted artifact content.", cleanupError);
      });
      return conflict();
    }
  } catch (error) {
    await env.ARTIFACTS.delete(nextContentKey).catch((cleanupError) => {
      console.error("Failed to clean up uncommitted artifact content.", cleanupError);
    });
    throw error;
  }

  const payload: UpdatePayload = {
    id,
    filename: nextMetadata.filename,
    updatedAt,
    expiresAt: nextMetadata.expiresAt,
    sandbox: nextMetadata.sandbox,
    size: nextMetadata.size,
    revision,
    contentSha256,
    attributes: nextMetadata.attributes,
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

      if (artifact.deletedAt) {
        continue;
      }

      artifacts.push({
        id: artifact.id,
        filename: artifact.filename,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
        sandbox: artifact.sandbox,
        size: artifact.size,
        revision: artifact.revision,
        contentSha256: artifact.contentSha256,
        attributes: artifact.attributes,
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

  const stored = await readStoredMetadata(env, id);

  if (!stored || stored.metadata.deletedAt) {
    return notFound();
  }
  const { metadata } = stored;

  if (metadata.expiresAt && Date.now() >= Date.parse(metadata.expiresAt)) {
    return json({ error: "Artifact has expired." }, 410);
  }

  const token = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const encryptedToken = await encryptViewerToken(env, id, token);
  const { encryptedToken: _previousEncryptedToken, ...metadataWithoutEncryptedToken } = metadata;
  const nextMetadata: ArtifactMetadata = {
    ...metadataWithoutEncryptedToken,
    tokenHash,
    revision: metadata.revision + 1,
    updatedAt: new Date().toISOString(),
    ...(encryptedToken ? { encryptedToken } : {}),
  };

  if (!(await writeMetadataIfMatch(env, id, nextMetadata, stored.etag))) {
    return conflict();
  }

  const payload: ReissuePayload = {
    id,
    url: `${publicOrigin(request, env)}/p/${id}/${token}`,
    expiresAt: metadata.expiresAt,
    sandbox: metadata.sandbox,
    revision: nextMetadata.revision,
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
    revision: metadata.revision,
    contentSha256: metadata.contentSha256,
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
      try {
        if (object.key.endsWith("/metadata.json")) {
          await cleanupExpiredArtifact(env, object.key);
        } else if (isArtifactContentKey(object.key)) {
          await cleanupOrphanedContent(env, object);
        }
      } catch (error) {
        console.error("Failed to clean up artifact storage.", object.key, error);
      }
    }
  } while (cursor);
}

async function cleanupExpiredArtifact(env: Env, key: string): Promise<void> {
  const id = key.split("/").at(-2);

  if (!id) {
    return;
  }
  const stored = await readStoredMetadata(env, id);

  if (!stored) {
    return;
  }
  const { metadata } = stored;

  if (!metadata.deletedAt && (!metadata.expiresAt || Date.now() < Date.parse(metadata.expiresAt))) {
    return;
  }

  if (!metadata.deletedAt) {
    const tombstone = tombstoneMetadata(metadata);

    if (!(await writeMetadataIfMatch(env, metadata.id, tombstone, stored.etag))) {
      return;
    }
  }

  await deleteArtifactContent(env, metadata.id);
  await env.ARTIFACTS.delete(metadataKey(metadata.id));
}

async function cleanupOrphanedContent(env: Env, object: R2Object): Promise<void> {
  if (Date.now() - object.uploaded.getTime() < ORPHAN_CONTENT_GRACE_MS) {
    return;
  }

  const id = object.key.split("/")[1];

  if (!id) {
    return;
  }

  const stored = await readStoredMetadata(env, id);

  if (stored?.metadata.contentKey === object.key) {
    return;
  }

  await env.ARTIFACTS.delete(object.key);
}

async function deleteArtifact(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  if (!isValidId(id)) {
    return notFound();
  }

  const stored = await readStoredMetadata(env, id);

  if (!stored || stored.metadata.deletedAt) {
    return notFound();
  }

  const tombstone = tombstoneMetadata(stored.metadata);

  if (!(await writeMetadataIfMatch(env, id, tombstone, stored.etag))) {
    return conflict();
  }

  await deleteArtifactContent(env, id);
  await env.ARTIFACTS.delete(metadataKey(id));

  return json({ id, deleted: true });
}

function serveDashboard(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PageBin artifacts</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--surface:#fffdf8;--text:#1d2724;--muted:#68716d;--line:#d8d4ca;--accent:#99602f;--danger:#a33a32}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:40px 24px 80px}header{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:28px}h1{font:700 clamp(2rem,5vw,4rem)/.95 ui-serif,Georgia,serif;margin:0}header p{color:var(--muted);max-width:42rem;margin:8px 0 0}.filters{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:10px;margin:24px 0}input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);padding:10px 12px}button{cursor:pointer}button:hover{border-color:var(--accent)}button.danger{color:var(--danger)}.summary{color:var(--muted);margin:12px 0}.group{margin-top:30px}.group h2{font:700 1.1rem ui-monospace,monospace;border-bottom:1px solid var(--line);padding-bottom:8px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}.card h3{margin:0 0 4px;font-size:1rem}.meta{color:var(--muted);font-size:.85rem;overflow-wrap:anywhere}.badges{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.badge{border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:.75rem}.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}.actions button{padding:6px 9px;font-size:.82rem}.empty{padding:60px 20px;text-align:center;color:var(--muted)}@media(max-width:760px){header{display:block}.filters{grid-template-columns:1fr 1fr}.filters input{grid-column:1/-1}}@media(prefers-color-scheme:dark){:root{--bg:#171b19;--surface:#202522;--text:#edf0ed;--muted:#a6aea9;--line:#3a423e;--accent:#d39a62;--danger:#ef8c82}}
</style>
</head>
<body><main><header><div><h1>PageBin</h1><p>Unlisted plans, reports, reviews, and implementation logs. Access to this catalog is protected by Cloudflare Access.</p></div><button id="refresh">Refresh</button></header><section class="filters" aria-label="Artifact filters"><input id="search" type="search" placeholder="Search title, filename, project, or host"><select id="project"><option value="">All projects</option></select><select id="host"><option value="">All hosts</option></select><select id="status"><option value="">All statuses</option><option>draft</option><option>active</option><option>done</option><option>superseded</option><option>archived</option></select></section><p class="summary" id="summary">Loading artifacts…</p><div id="artifacts"></div></main>
<script>
const state={artifacts:[]};const $=id=>document.getElementById(id);const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node};
function option(select,value){if(!value||[...select.options].some(item=>item.value===value))return;const node=document.createElement('option');node.value=value;node.textContent=value;select.append(node)}
async function load(){const response=await fetch('/api/dashboard/artifacts');if(!response.ok)throw new Error('Unable to load artifacts');const payload=await response.json();state.artifacts=payload.artifacts;for(const item of state.artifacts){option($('project'),item.attributes.project);option($('host'),item.attributes.sourceHost)}render()}
function matches(item){const query=$('search').value.trim().toLowerCase();const values=[item.attributes.title,item.filename,item.attributes.project,item.attributes.sourceHost].filter(Boolean).join(' ').toLowerCase();return(!query||values.includes(query))&&(!$('project').value||item.attributes.project===$('project').value)&&(!$('host').value||item.attributes.sourceHost===$('host').value)&&(!$('status').value||item.attributes.status===$('status').value)}
function button(label,handler,className){const node=text('button',label,className);node.type='button';node.addEventListener('click',handler);return node}
async function copyLink(id){const response=await fetch('/api/dashboard/artifacts/'+encodeURIComponent(id)+'/link');const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Unable to recover link');await navigator.clipboard.writeText(payload.url)}
async function reissue(id){if(!confirm('Reissue this link? The previous public URL will stop working.'))return;const response=await fetch('/api/dashboard/artifacts/'+encodeURIComponent(id)+'/reissue',{method:'POST',headers:{'X-PageBin-Dashboard':'1'}});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Unable to reissue');await navigator.clipboard.writeText(payload.url);await load()}
async function remove(id){if(!confirm('Delete this artifact permanently?'))return;const response=await fetch('/api/dashboard/artifacts/'+encodeURIComponent(id),{method:'DELETE',headers:{'X-PageBin-Dashboard':'1'}});if(!response.ok)throw new Error('Unable to delete');await load()}
function render(){const root=$('artifacts');root.replaceChildren();const items=state.artifacts.filter(matches);$('summary').textContent=items.length+' of '+state.artifacts.length+' artifacts';if(!items.length){root.append(text('div','No artifacts match these filters.','empty'));return}const groups=new Map;for(const item of items){const key=item.attributes.project||'Uncategorized';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item)}for(const [name,artifacts] of [...groups].sort(([a],[b])=>a.localeCompare(b))){const section=document.createElement('section');section.className='group';section.append(text('h2',name));const grid=document.createElement('div');grid.className='grid';for(const item of artifacts){const card=document.createElement('article');card.className='card';card.append(text('h3',item.attributes.title||item.filename),text('div',[item.attributes.sourceHost,item.attributes.gitBranch,item.attributes.gitCommit?.slice(0,8)].filter(Boolean).join(' · ')||'No source metadata','meta'));const badges=document.createElement('div');badges.className='badges';for(const value of [item.attributes.artifactType,item.attributes.status,item.expiresAt?'expires '+new Date(item.expiresAt).toLocaleDateString():'long-lived'])if(value)badges.append(text('span',value,'badge'));card.append(badges,text('div','Updated '+new Date(item.updatedAt).toLocaleString()+' · revision '+item.revision,'meta'));const actions=document.createElement('div');actions.className='actions';actions.append(button('Open',()=>window.open('/api/dashboard/artifacts/'+encodeURIComponent(item.id)+'/open','_blank')),button('Copy link',()=>copyLink(item.id).catch(alert)),button('Reissue',()=>reissue(item.id).catch(alert)),button('Delete',()=>remove(item.id).catch(alert),'danger'));card.append(actions);grid.append(card)}section.append(grid);root.append(section)}}
for(const id of ['search','project','host','status'])$(id).addEventListener('input',render);$('refresh').addEventListener('click',()=>load().catch(error=>$('summary').textContent=error.message));load().catch(error=>$('summary').textContent=error.message);
</script></body></html>`;

  return text(html, 200, {
    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
  });
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
  const version = metadata.revision;
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
      if (payload.revision && payload.revision !== pagebinVersion) {
        pagebinVersion = payload.revision;
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

  let object = await env.ARTIFACTS.get(metadata.contentKey);

  if (!object) {
    const currentMetadata = await readAuthorizedMetadata(env, id, token);

    if (!currentMetadata || currentMetadata.contentKey === metadata.contentKey) {
      return notFound();
    }

    object = await env.ARTIFACTS.get(currentMetadata.contentKey);

    if (!object) {
      return notFound();
    }
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

  if (metadata.deletedAt || (metadata.expiresAt && Date.now() >= Date.parse(metadata.expiresAt))) {
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

function parsePublishOptions(
  form: FormData,
): { ttlSeconds: number | null; sandbox: SandboxMode; attributes: ArtifactAttributes } | { error: string } {
  try {
    return {
      sandbox: parseSandbox(form.get("sandbox")),
      ttlSeconds: parseOptionalPositiveInt(form.get("ttlSeconds")),
      attributes: parseArtifactAttributes(form),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid publish options.",
    };
  }
}

function parseArtifactAttributes(form: FormData): ArtifactAttributes {
  const value = form.get("attributes");

  if (value === null || value === "") {
    return {};
  }

  if (typeof value !== "string") {
    throw new Error("Artifact attributes must be JSON.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Artifact attributes must be valid JSON.");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Artifact attributes must be a JSON object.");
  }

  const allowedKeys = new Set([
    "title",
    "project",
    "repo",
    "sourceHost",
    "gitBranch",
    "gitCommit",
    "sourcePath",
    "artifactType",
    "status",
    "agent",
  ]);

  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown artifact attribute: ${key}.`);
    }
  }

  return Object.fromEntries(
    Object.entries({
      title: readOptionalAttribute(parsed, "title", 200),
      project: readOptionalAttribute(parsed, "project", 200),
      repo: readOptionalAttribute(parsed, "repo", 2048),
      sourceHost: readOptionalAttribute(parsed, "sourceHost", 255),
      gitBranch: readOptionalAttribute(parsed, "gitBranch", 255),
      gitCommit: readOptionalAttribute(parsed, "gitCommit", 128),
      sourcePath: readOptionalAttribute(parsed, "sourcePath", 1024),
      artifactType: readArtifactType(parsed.artifactType),
      status: readArtifactStatus(parsed.status),
      agent: readOptionalAttribute(parsed, "agent", 255),
    }).filter(([, attribute]) => attribute !== undefined),
  ) as ArtifactAttributes;
}

function readOptionalAttribute(object: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = object[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
    throw new Error(`Invalid artifact attribute: ${key}.`);
  }

  return value;
}

function readArtifactType(value: unknown): ArtifactType | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "plan" || value === "report" || value === "review" || value === "explainer" || value === "implementation-log" || value === "other") {
    return value;
  }

  throw new Error("Invalid artifact attribute: artifactType.");
}

function readArtifactStatus(value: unknown): ArtifactStatus | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "draft" || value === "active" || value === "done" || value === "superseded" || value === "archived") {
    return value;
  }

  throw new Error("Invalid artifact attribute: status.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function versionedHtmlKey(id: string, revision: number): string {
  return `artifacts/${id}/content/${revision}-${randomBase64Url(8)}.html`;
}

function isArtifactContentKey(key: string): boolean {
  return key.endsWith("/index.html") || key.includes("/content/");
}

async function deleteArtifactContent(env: Env, id: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const options: R2ListOptions = cursor ? { cursor, prefix: `artifacts/${id}/` } : { prefix: `artifacts/${id}/` };
    const result = await env.ARTIFACTS.list(options);

    cursor = result.truncated ? result.cursor : undefined;

    for (const object of result.objects) {
      if (object.key !== metadataKey(id)) {
        await env.ARTIFACTS.delete(object.key);
      }
    }
  } while (cursor);
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return base64Url(bytes);
}

function publicOrigin(request: Request, env: Env): string {
  const configured = env.PAGEBIN_PUBLIC_ORIGIN?.trim();

  if (!configured) {
    return new URL(request.url).origin;
  }

  const url = new URL(configured);
  return url.origin;
}

async function encryptViewerToken(env: Env, id: string, token: string): Promise<EncryptedViewerToken | null> {
  const key = await importCapabilityKey(env);

  if (!key) {
    return null;
  }

  const keyVersion = env.PAGEBIN_CAPABILITY_KEY_VERSION?.trim() || "v1";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`${id}:${keyVersion}`),
    },
    key,
    new TextEncoder().encode(token),
  );

  return {
    ciphertext: base64Url(new Uint8Array(ciphertext)),
    iv: base64Url(iv),
    keyVersion,
  };
}

async function decryptViewerToken(env: Env, id: string, encrypted: EncryptedViewerToken): Promise<string | null> {
  const configuredVersion = env.PAGEBIN_CAPABILITY_KEY_VERSION?.trim() || "v1";

  if (encrypted.keyVersion !== configuredVersion) {
    return null;
  }

  const key = await importCapabilityKey(env);

  if (!key) {
    return null;
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(encrypted.iv),
        additionalData: new TextEncoder().encode(`${id}:${encrypted.keyVersion}`),
      },
      key,
      decodeBase64Url(encrypted.ciphertext),
    );

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
  } catch {
    return null;
  }
}

async function importCapabilityKey(env: Env): Promise<CryptoKey | null> {
  const value = env.PAGEBIN_CAPABILITY_KEY?.trim();

  if (!value) {
    return null;
  }

  const bytes = decodeBase64Url(value);

  if (bytes.byteLength !== 32) {
    throw new Error("PAGEBIN_CAPABILITY_KEY must be a base64url-encoded 32-byte key.");
  }

  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
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

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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
    revision: metadata.revision ?? 1,
    contentKey: metadata.contentKey ?? htmlKey(metadata.id),
    contentSha256: metadata.contentSha256 ?? null,
    attributes: metadata.attributes ?? {},
  };
}

async function readStoredMetadata(env: Env, id: string): Promise<StoredArtifactMetadata | null> {
  const object = await env.ARTIFACTS.get(metadataKey(id));

  if (!object) {
    return null;
  }

  return {
    metadata: normalizeMetadata(JSON.parse(await object.text()) as ArtifactMetadata),
    etag: object.etag,
  };
}

async function writeMetadataIfMatch(
  env: Env,
  id: string,
  metadata: ArtifactMetadata,
  etag: string,
): Promise<boolean> {
  const result = await env.ARTIFACTS.put(metadataKey(id), JSON.stringify(metadata), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    onlyIf: { etagMatches: etag },
  });

  return result !== null;
}

function tombstoneMetadata(metadata: ArtifactMetadata): ArtifactMetadata {
  return {
    ...metadata,
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: metadata.revision + 1,
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

function misdirected(): Response {
  return text("Misdirected request.\n", 421, { "Content-Type": "text/plain; charset=utf-8" });
}

function conflict(): Response {
  return json({ error: "Artifact changed concurrently. Retry the request." }, 409);
}

function secureHeaders(headers: HeadersInit = {}): Headers {
  const next = new Headers(headers);

  next.set("Cache-Control", "private, max-age=0, no-store, no-transform");
  next.set("Referrer-Policy", "no-referrer");
  next.set("X-Content-Type-Options", "nosniff");
  next.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  next.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  return next;
}
