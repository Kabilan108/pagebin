import { type ContentFile, type ContentManifest, type StoredFile, FILE_LIMIT, BUNDLE_LIMIT, FILE_COUNT_LIMIT, validPath, contentType, contentKind, manifestSource, filePathUrl } from "../shared/content";
import { FAVICON_SVG, dashboardHtml } from "./dashboard";
import { NOT_FOUND_HTML } from "./not-found";

interface Env {
  ARTIFACTS: R2Bucket;
  PAGEBIN_MAX_BYTES?: string;
  PAGEBIN_MAX_FILE_BYTES?: string;
  PAGEBIN_PUBLISH_TOKEN: string;
  PAGEBIN_PUBLIC_ORIGIN?: string;
  PAGEBIN_CAPABILITY_KEY?: string;
  PAGEBIN_CAPABILITY_KEY_VERSION?: string;
  PAGEBIN_ACCESS_TEAM_DOMAIN?: string;
  PAGEBIN_ACCESS_AUD?: string;
  PAGEBIN_DEV_ADMIN_HOSTNAMES?: string;
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
  versions: ArtifactVersion[];
  currentVersion: number;
  deletedAt?: string;
  attributes: ArtifactAttributes;
  encryptedToken?: EncryptedViewerToken | undefined;
}

interface ArtifactVersion {
  manifest?: ContentManifest | undefined;
  filename?: string;
  version: number;
  contentKey: string;
  contentSha256: string | null;
  size: number;
  createdAt: string;
}

interface ArtifactVersionSummary {
  version: number;
  size: number;
  createdAt: string;
  contentSha256: string | null;
  current: boolean;
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
  agent?: string;
}

interface PublishPayload {
  id: string;
  url: string;
  expiresAt: string | null;
  sandbox: SandboxMode;
  revision: number;
  version: number;
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
  version: number;
  contentSha256: string | null;
  attributes: ArtifactAttributes;
}

interface VersionPayload {
  id: string;
  updatedAt: string;
  size: number;
  revision: number;
  version: number;
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
  version: number;
  versions: ArtifactVersionSummary[];
  manifest?: ContentManifest | undefined;
}

interface StoredArtifactMetadata {
  metadata: ArtifactMetadata;
  etag: string;
}

type SandboxMode = "standard" | "strict";
type ArtifactType = "plan" | "report" | "review" | "explainer" | "implementation-log" | "other";

interface UploadedFile {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const ORPHAN_CONTENT_GRACE_MS = 60 * 60 * 1000;
const MAX_ARTIFACT_VERSIONS = 10;
const METADATA_READ_CONCURRENCY = 6;
const STANDARD_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
const STANDARD_IFRAME_PERMISSIONS = "clipboard-write";
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

  if (request.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) {
    return serveFavicon();
  }

  if (isAdminHostname(hostname, env)) {
    const dashboardResponse = await routeDashboard(request, env, url, hostname);

    if (dashboardResponse) {
      return dashboardResponse;
    }

    if (hostname === "admin.page-bin.com") {
      return siteNotFound();
    }
  }

  const publicVersionPath =
    /^\/api\/artifacts\/[^/]+\/version\/[^/]+$/.test(url.pathname) ||
    /^\/api\/artifacts\/[^/]+\/versions\/[^/]+$/.test(url.pathname) ||
    /^\/api\/artifacts\/[^/]+\/manifest\/[^/]+(?:\/v\/[1-9]\d*)?$/.test(url.pathname);

  if (hostname === "page-bin.com" && url.pathname.startsWith("/api/") && !publicVersionPath) {
    return misdirected();
  }

  if (hostname === "api.page-bin.com" && (url.pathname === "/" || url.pathname.startsWith("/p/") || url.pathname.startsWith("/raw/") || url.pathname.startsWith("/download/"))) {
    return misdirected();
  }

  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return text("User-agent: *\nDisallow: /\n", 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  }

  if (url.pathname === "/api/uploads" || url.pathname.startsWith("/api/uploads/")) {
    if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized." }, 401);
    return routeUpload(request, env, url);
  }
  const manifestMatch = /^\/api\/artifacts\/([^/]+)\/manifest\/([^/]+)(?:\/v\/([1-9]\d*))?$/.exec(url.pathname);
  if (request.method === 'GET' && manifestMatch) {
    const metadata = await readAuthorizedMetadata(env, manifestMatch[1]!, manifestMatch[2]!);
    if (!metadata) return siteNotFound();
    const entry = manifestMatch[3] ? metadata.versions.find(v => v.version === Number(manifestMatch[3])) : artifactHead(metadata);
    if (!entry?.manifest) return notFound();
    return json({ version: entry.version, revision: metadata.revision, manifest: { ...entry.manifest, files: entry.manifest.files.map(({objectKey: _, ...file}) => file) } });
  }
  const fileMatch = url.pathname.match(/^\/(raw|download)\/([^/]+)\/([^/]+)(?:\/v\/([1-9]\d*)(?:\/(.+))?)?$/);
  if ((request.method === "GET" || request.method === "HEAD") && fileMatch) {
    const metadata = await readAuthorizedMetadata(env, fileMatch[2]!, fileMatch[3]!);
    if (!metadata) return siteNotFound();
    const entry = fileMatch[4] ? metadata.versions.find(v => v.version === Number(fileMatch[4])) : artifactHead(metadata);
    if (!entry) return siteNotFound();
    if (entry.manifest || fileMatch[1] === "download" || request.method === 'HEAD') return serveFile(request, env, metadata, entry, fileMatch[5], fileMatch[1] === "download");
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

  const rollbackMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/rollback$/);

  if (request.method === "POST" && rollbackMatch?.[1]) {
    return rollbackArtifact(request, env, rollbackMatch[1]);
  }

  const versionsMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/versions\/([^/]+)$/);

  if (request.method === "GET" && versionsMatch?.[1] && versionsMatch[2]) {
    return artifactVersions(env, versionsMatch[1], versionsMatch[2]);
  }

  const versionMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/version\/([^/]+)$/);

  if (request.method === "GET" && versionMatch?.[1] && versionMatch[2]) {
    return artifactVersion(env, versionMatch[1], versionMatch[2]);
  }

  const deleteMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);

  if (request.method === "GET" && deleteMatch?.[1]) {
    return getArtifact(request, env, deleteMatch[1]);
  }

  if (request.method === "PATCH" && deleteMatch?.[1]) {
    return updateArtifactTtl(request, env, deleteMatch[1]);
  }

  if (request.method === "DELETE" && deleteMatch?.[1]) {
    return deleteArtifact(request, env, deleteMatch[1]);
  }

  const pinnedViewerMatch = url.pathname.match(/^\/p\/([^/]+)\/([^/]+)\/v\/([^/]+)$/);

  if (request.method === "GET" && pinnedViewerMatch?.[1] && pinnedViewerMatch[2] && pinnedViewerMatch[3]) {
    return servePinnedViewer(env, request.url, pinnedViewerMatch[1], pinnedViewerMatch[2], pinnedViewerMatch[3]);
  }

  const viewerMatch = url.pathname.match(/^\/p\/([^/]+)\/([^/]+)$/);

  if (request.method === "GET" && viewerMatch?.[1] && viewerMatch[2]) {
    return serveViewer(env, request.url, viewerMatch[1], viewerMatch[2]);
  }

  const pinnedRawMatch = url.pathname.match(/^\/raw\/([^/]+)\/([^/]+)\/v\/([^/]+)$/);

  if (request.method === "GET" && pinnedRawMatch?.[1] && pinnedRawMatch[2] && pinnedRawMatch[3]) {
    return servePinnedRaw(env, pinnedRawMatch[1], pinnedRawMatch[2], pinnedRawMatch[3]);
  }

  const rawMatch = url.pathname.match(/^\/raw\/([^/]+)\/([^/]+)$/);

  if (request.method === "GET" && rawMatch?.[1] && rawMatch[2]) {
    return serveRaw(env, rawMatch[1], rawMatch[2]);
  }

  return url.pathname.startsWith("/api/") || hostname === "api.page-bin.com" ? notFound() : siteNotFound();
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

  const rollbackMatch = url.pathname.match(/^\/api\/dashboard\/artifacts\/([^/]+)\/rollback$/);

  if (request.method === "POST" && rollbackMatch?.[1]) {
    if (!hasDashboardMutationHeader(request)) {
      return json({ error: "Missing dashboard mutation header." }, 403);
    }

    const internalRequest = new Request(`${new URL(request.url).origin}/api/artifacts/${encodeURIComponent(rollbackMatch[1])}/rollback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PAGEBIN_PUBLISH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: await request.text(),
    });

    return rollbackArtifact(internalRequest, env, rollbackMatch[1]);
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

function isAdminHostname(hostname: string, env: Env): boolean {
  return (
    hostname === "admin.page-bin.com" ||
    isLocalDevHostname(hostname) ||
    devAdminHostnames(env).includes(hostname)
  );
}

function isLocalDevHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function devAdminHostnames(env: Env): string[] {
  return (env.PAGEBIN_DEV_ADMIN_HOSTNAMES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}


async function dashboardArtifacts(env: Env, url: URL): Promise<Response> {
  const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
  const project = url.searchParams.get("project")?.trim() ?? "";
  const sourceHost = url.searchParams.get("sourceHost")?.trim() ?? "";
  const now = Date.now();
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
        (!artifact.expiresAt || now < Date.parse(artifact.expiresAt))
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
    kind: contentKind(artifactHead(artifact).manifest?.files.find(f => f.path === artifactHead(artifact).manifest?.entrypoint)?.contentType ?? "text/html"),
    contentType: artifactHead(artifact).manifest?.files.find(f => f.path === artifactHead(artifact).manifest?.entrypoint)?.contentType ?? "text/html",
    fileCount: artifactHead(artifact).manifest?.files.length ?? 1,
    linkRecoverable: Boolean(artifact.encryptedToken),
    version: artifactHead(artifact).version,
    versions: artifactVersionSummaries(artifact),
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

    artifacts.push(...await readListedArtifactMetadata(env, result.objects));
  } while (cursor);

  return artifacts;
}

async function readListedArtifactMetadata(env: Env, objects: R2Object[]): Promise<ArtifactMetadata[]> {
  const keys = objects.filter((object) => object.key.endsWith("/metadata.json")).map((object) => object.key);
  const results = new Array<ArtifactMetadata | null>(keys.length).fill(null);
  let nextIndex = 0;

  const readNext = async (): Promise<void> => {
    while (nextIndex < keys.length) {
      const index = nextIndex;
      nextIndex += 1;
      const key = keys[index];

      if (!key) {
        continue;
      }

      const stored = await env.ARTIFACTS.get(key);

      if (!stored) {
        continue;
      }

      const serialized = await stored.text();

      try {
        const metadata = normalizeMetadata(JSON.parse(serialized) as ArtifactMetadata);

        if (!metadata.deletedAt) {
          results[index] = metadata;
        }
      } catch (error) {
        console.error(`Unable to read artifact metadata at ${key}.`, error);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(METADATA_READ_CONCURRENCY, keys.length) }, readNext));

  return results.filter((metadata): metadata is ArtifactMetadata => metadata !== null);
}

async function isDashboardAuthorized(request: Request, env: Env, hostname: string): Promise<boolean> {
  if (isLocalDevHostname(hostname) || devAdminHostnames(env).includes(hostname)) {
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
  const head = artifactHead(metadata);
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
    version: head.version,
    versions: artifactVersionSummaries(metadata),
    manifest: head.manifest,
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
    versions: [
      {
        version: 1,
        contentKey: htmlKey(id),
        contentSha256,
        size: upload.file.size,
        createdAt: nowIso,
      },
    ],
    currentVersion: 1,
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
    version: 1,
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

  if (artifactHead(metadata).manifest) {
    return json({ error: "This artifact uses a file manifest. Update it with the staged upload API; include --assets when updating an HTML bundle from another machine." }, 400);
  }

  const upload = await readHtmlUpload(request, env);

  if ("error" in upload) {
    return json({ error: upload.error }, upload.status);
  }

  const contentSha256 = await sha256Hex(upload.html);
  let attributes: ArtifactAttributes;
  let ttlSeconds: number | null | undefined;

  try {
    attributes = parseArtifactAttributes(upload.form);
    const ttlValue = upload.form.get("ttlSeconds");
    ttlSeconds = ttlValue === null ? undefined : parseUpdateTtl(ttlValue);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid artifact attributes." }, 400);
  }

  const mergedAttributes = {
    ...metadata.attributes,
    ...attributes,
  };

  if (metadata.contentSha256 !== null && contentSha256 === metadata.contentSha256) {
    const isNoOp =
      upload.displayFilename === metadata.filename &&
      JSON.stringify(mergedAttributes) === JSON.stringify(metadata.attributes) &&
      ttlSeconds === undefined;

    if (isNoOp) {
      return json(updatePayload(metadata));
    }

    const updatedAt = new Date().toISOString();
    const nextMetadata: ArtifactMetadata = {
      ...metadata,
      filename: upload.displayFilename,
      updatedAt,
      revision: metadata.revision + 1,
      attributes: mergedAttributes,
      expiresAt: updatedExpiration(metadata.expiresAt, ttlSeconds, updatedAt),
    };

    if (!(await writeMetadataIfMatch(env, id, nextMetadata, stored.etag))) {
      return conflict();
    }

    return json(updatePayload(nextMetadata));
  }

  const updatedAt = new Date().toISOString();
  const revision = metadata.revision + 1;
  const nextContentKey = versionedHtmlKey(id, revision);
  const nextVersion: ArtifactVersion = {
    version: (metadata.versions[metadata.versions.length - 1] as ArtifactVersion).version + 1,
    contentKey: nextContentKey,
    contentSha256,
    size: upload.file.size,
    createdAt: updatedAt,
  };
  const nextMetadata: ArtifactMetadata = {
    ...metadata,
    filename: upload.displayFilename,
    updatedAt,
    size: upload.file.size,
    revision,
    contentKey: nextContentKey,
    contentSha256,
    versions: appendArtifactVersion(metadata.versions, nextVersion),
    currentVersion: nextVersion.version,
    attributes: mergedAttributes,
    expiresAt: updatedExpiration(metadata.expiresAt, ttlSeconds, updatedAt),
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

  return json(updatePayload(nextMetadata));
}

async function updateArtifactTtl(request: Request, env: Env, id: string): Promise<Response> {
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

  if (stored.metadata.expiresAt && Date.now() >= Date.parse(stored.metadata.expiresAt)) {
    return json({ error: "Artifact has expired." }, 410);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return json({ error: "TTL update body must be valid JSON." }, 400);
  }

  if (!isPlainObject(body) || !Object.hasOwn(body, "ttlSeconds") || Object.keys(body).length !== 1) {
    return json({ error: "TTL update body must contain only ttlSeconds." }, 400);
  }

  let ttlSeconds: number | null | undefined;

  try {
    ttlSeconds = parseUpdateTtl(body.ttlSeconds);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid TTL." }, 400);
  }

  if (ttlSeconds === undefined) {
    return json({ error: "ttlSeconds is required." }, 400);
  }

  const updatedAt = new Date().toISOString();
  const nextMetadata: ArtifactMetadata = {
    ...stored.metadata,
    updatedAt,
    revision: stored.metadata.revision + 1,
    expiresAt: updatedExpiration(stored.metadata.expiresAt, ttlSeconds, updatedAt),
  };

  if (!(await writeMetadataIfMatch(env, id, nextMetadata, stored.etag))) {
    return conflict();
  }

  return json(updatePayload(nextMetadata));
}

async function listArtifacts(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized." }, 401);
  }

  const artifacts: ListedArtifact[] = (await readAllArtifactMetadata(env)).map((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
        sandbox: artifact.sandbox,
        size: artifact.size,
        revision: artifact.revision,
        contentSha256: artifact.contentSha256,
        attributes: artifact.attributes,
      }));

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

async function rollbackArtifact(request: Request, env: Env, id: string): Promise<Response> {
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

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Rollback body must be valid JSON." }, 400);
  }

  if (!isPlainObject(body) || !Object.hasOwn(body, "version") || Object.keys(body).length !== 1) {
    return json({ error: "Rollback body must contain only version." }, 400);
  }

  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version <= 0) {
    return json({ error: "Rollback version must be a positive integer." }, 400);
  }

  const target = metadata.versions.find((entry) => entry.version === body.version);

  if (!target) {
    return json({ error: `Version ${body.version} is not available for this artifact.` }, 400);
  }

  if (target.version === metadata.currentVersion) {
    return json(updatePayload(metadata));
  }

  const updatedAt = new Date().toISOString();
  const nextMetadata: ArtifactMetadata = {
    ...metadata,
    updatedAt,
    size: target.size,
    revision: metadata.revision + 1,
    contentKey: target.contentKey,
    contentSha256: target.contentSha256,
    currentVersion: target.version,
    filename: target.filename ?? metadata.filename,
  };

  if (!(await writeMetadataIfMatch(env, id, nextMetadata, stored.etag))) {
    return conflict();
  }

  return json(updatePayload(nextMetadata));
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
    version: artifactHead(metadata).version,
    contentSha256: metadata.contentSha256,
  };

  return json(payload);
}

async function artifactVersions(env: Env, id: string, token: string): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);

  if (!metadata) {
    return notFound();
  }

  return json({
    id: metadata.id,
    version: artifactHead(metadata).version,
    versions: artifactVersionSummaries(metadata),
  });
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

  const referencedKeys = new Set(stored?.metadata.versions.flatMap((version) => [version.contentKey, ...(version.manifest?.files.map(f => f.objectKey) ?? [])]) ?? []);

  if (stored) {
    referencedKeys.add(stored.metadata.contentKey);
  }

  if (referencedKeys.has(object.key)) {
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
  return text(dashboardHtml(), 200, {
    "Content-Security-Policy":
      "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
  });
}

function serveFavicon(): Response {
  return new Response(FAVICON_SVG, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

const VIEWER_BAR_CSS = `
:root{color-scheme:light dark;--pb-panel:#fffdf6;--pb-chip:#efeadd;--pb-text:#241f18;--pb-muted:#877e6f;--pb-faint:#a89f8e;--pb-line:#ddd6c6;--pb-accent:#8a5426;--pb-green:#6f9556}
@media(prefers-color-scheme:dark){:root{--pb-panel:#211e19;--pb-chip:#26221c;--pb-text:#ece7dc;--pb-muted:#a29a8a;--pb-faint:#7a7365;--pb-line:#37322a;--pb-accent:#d39a62;--pb-green:#93b06e}}
body{padding-top:34px;box-sizing:border-box}
.pagebin-bar{position:fixed;inset:0 0 auto;height:34px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:0 10px 0 14px;border-bottom:1px solid var(--pb-line);background:var(--pb-chip);font:12px/1 ui-sans-serif,system-ui,sans-serif;color:var(--pb-muted);z-index:2}
.pb-identity{flex:1;min-width:0;display:flex;align-items:center;gap:7px}
.pb-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--pb-muted)}
.pb-agent-sep{color:var(--pb-faint);flex-shrink:0}
.pb-agent{display:inline-flex;align-items:center;flex-shrink:0;color:var(--pb-muted)}
.pb-agent svg{width:13px;height:13px;display:block;fill:currentColor}
.pb-agent-claude{color:#c46a4a}.pb-agent-amp{color:#c9573f}
.pb-agent-name{max-width:min(32vw,240px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--pb-text);flex-shrink:1}
@media(prefers-color-scheme:dark){.pb-agent-claude{color:#d97757}.pb-agent-codex,.pb-agent-opencode{color:#c9c3b4}.pb-agent-amp{color:#e56a50}}
.pb-live{width:6px;height:6px;border-radius:50%;background:var(--pb-green);flex-shrink:0;animation:pbpulse 2.4s ease-in-out infinite}
@keyframes pbpulse{0%,100%{opacity:1}50%{opacity:.25}}
.pb-dd{position:relative;display:inline-flex;flex-shrink:0}
.pb-dd .trigger{font:inherit;font-size:11.5px;border:1px solid var(--pb-line);border-radius:6px;background:var(--pb-panel);color:var(--pb-text);padding:4px 24px 4px 10px;cursor:pointer;position:relative}
.pb-dd .trigger::after{content:'';position:absolute;right:9px;top:50%;width:6px;height:6px;border-right:1.5px solid var(--pb-muted);border-bottom:1.5px solid var(--pb-muted);transform:translateY(-70%) rotate(45deg)}
.pb-dd .trigger:hover{border-color:var(--pb-accent)}
.pb-dd .menu{position:absolute;z-index:30;top:calc(100% + 4px);right:0;min-width:100%;background:var(--pb-panel);border:1px solid var(--pb-line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;display:none;max-height:60vh;overflow-y:auto}
.pb-dd.open .menu{display:block}
.pb-dd .menu a{display:block;font-size:11.5px;color:var(--pb-text);text-decoration:none;padding:6px 12px;border-radius:5px;white-space:nowrap}
.pb-dd .menu a:hover{background:var(--pb-chip)}
.pb-dd .menu a.sel{color:var(--pb-accent);font-weight:600}
.pb-dd select{display:none;font:inherit;font-size:13px;border:1px solid var(--pb-line);border-radius:6px;background:var(--pb-panel);color:var(--pb-text);padding:4px 8px}
@media(pointer:coarse){.pb-dd .trigger,.pb-dd .menu{display:none!important}.pb-dd select{display:block}}
.pb-copy{border:none;background:none;color:var(--pb-muted);cursor:pointer;padding:5px;border-radius:6px;display:flex;align-items:center;flex-shrink:0}
.pb-copy:hover{color:var(--pb-accent);background:var(--pb-panel)}
.pb-copy.ok{color:var(--pb-green)}
.pb-copy svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.media-view{min-height:calc(100vh - 34px);box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px;background:var(--pb-panel);color:var(--pb-text);font:14px ui-sans-serif,system-ui}.media-view img,.media-view video{max-width:100%;max-height:75vh;object-fit:contain}.media-view a{color:var(--pb-accent)}.media-view p{max-width:60ch;overflow-wrap:anywhere}
`;

const VIEWER_COPY_ICON = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;

type ViewerAgentBrand = "amp" | "claude" | "codex" | "opencode";

const VIEWER_AGENT_ICONS: Record<ViewerAgentBrand, string> = {
  amp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 1.8L4.5 13.5h5.4l-1.8 8.7 8.7-11.7h-5.4z"/></svg>',
  claude:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
  codex:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  opencode: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>',
};

function viewerAgentBrand(agent: string): ViewerAgentBrand | null {
  const normalized = agent.toLowerCase();

  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized === "amp" || normalized.includes("ampcode")) return "amp";

  return null;
}

function viewerAgentHtml(agent: string | undefined): string {
  if (!agent) {
    return "";
  }

  const escapedAgent = escapeHtml(agent);
  const brand = viewerAgentBrand(agent);

  if (brand) {
    return `<span class="pb-agent pb-agent-${brand}" role="img" aria-label="Published by ${escapedAgent}" title="Published by ${escapedAgent}">${VIEWER_AGENT_ICONS[brand]}</span>`;
  }

  return `<span class="pb-agent-name" title="Publishing agent">${escapedAgent}</span>`;
}

function scrubberBarHtml(id: string, token: string, metadata: ArtifactMetadata, pinnedVersion: number | null): string {
  const current = artifactHead(metadata).version;
  const viewed = pinnedVersion ?? current;
  const basePath = `/p/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
  const versionHref = (version: number): string => (version === current ? basePath : `${basePath}/v/${version}`);
  const newestFirst = [...metadata.versions].reverse();
  const menuItems = newestFirst
    .map(
      (entry) =>
        `<a${entry.version === viewed ? ' class="sel"' : ""} href="${escapeHtml(versionHref(entry.version))}">v${entry.version} · ${escapeHtml(entry.createdAt.slice(0, 10))}</a>`,
    )
    .join("");
  const options = newestFirst
    .map(
      (entry) =>
        `<option value="${escapeHtml(versionHref(entry.version))}"${entry.version === viewed ? " selected" : ""}>v${entry.version}</option>`,
    )
    .join("");
  const liveDot = pinnedVersion === null ? `<i class="pb-live" title="Follows updates automatically"></i>` : "";
  const dropdown = `<span class="pb-dd" id="pagebin-dd"><button class="trigger" type="button">v<span id="pagebin-vnum">${viewed}</span></button><div class="menu">${menuItems}</div><select aria-label="Version">${options}</select></span>`;
  const copy = `<button class="pb-copy" id="pagebin-copy" type="button" title="Copy link to this version">${VIEWER_COPY_ICON}</button>`;
  const agent = viewerAgentHtml(metadata.attributes.agent);
  const identity = `<span class="pb-identity"><span class="pb-name">${escapeHtml(metadata.filename)}</span>${agent ? `<span class="pb-agent-sep" aria-hidden="true">·</span>${agent}` : ""}</span>`;

  return `<div class="pagebin-bar">${identity}${liveDot}${dropdown}${copy}</div>`;
}

function scrubberBarScript(id: string, token: string, viewedVersion: number): string {
  const basePath = `/p/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;

  return `
const pagebinCopyPath = ${JSON.stringify(`${basePath}/v/${viewedVersion}`)};
const pagebinCopyButton = document.getElementById("pagebin-copy");
if (pagebinCopyButton) {
  pagebinCopyButton.addEventListener("click", async () => {
    const url = location.origin + pagebinCopyPath;
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      const area = document.createElement("textarea");
      area.value = url;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { copied = document.execCommand("copy"); } catch {}
      area.remove();
    }
    if (!copied) {
      prompt("Copy this link:", url);
      return;
    }
    pagebinCopyButton.classList.add("ok");
    setTimeout(() => pagebinCopyButton.classList.remove("ok"), 1200);
  });
}
const pagebinDd = document.getElementById("pagebin-dd");
if (pagebinDd) {
  const trigger = pagebinDd.querySelector(".trigger");
  const select = pagebinDd.querySelector("select");
  if (trigger) {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      pagebinDd.classList.toggle("open");
    });
    document.addEventListener("click", () => pagebinDd.classList.remove("open"));
  }
  if (select) {
    select.addEventListener("input", () => {
      if (select.value) {
        location.href = select.value;
      }
    });
  }
}
`;
}

async function serveViewer(env: Env, requestUrl: string, id: string, token: string): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);

  if (!metadata) {
    return siteNotFound();
  }

  const url = new URL(requestUrl);
  const rawPath = artifactHead(metadata).manifest ? manifestRawPath(id, token, artifactHead(metadata)) : `/raw/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
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
${VIEWER_BAR_CSS}
</style>
</head>
<body>
${scrubberBarHtml(id, token, metadata, null)}${contentViewer(metadata, artifactHead(metadata), rawPath, sandbox)}
<script>
${scrubberBarScript(id, token, artifactHead(metadata).version)}
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
  try {
    const response = await fetch(${JSON.stringify(versionPath)}, { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      if (payload.revision && payload.revision !== pagebinVersion) {
        location.reload();
        return;
      }
    }
  } catch {}
  pagebinDelayMs = Math.min(pagebinDelayMs * 1.5, pagebinMaxDelayMs);
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
    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; frame-src 'self'; img-src 'self'; media-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    Link: `<${url.origin}/robots.txt>; rel="robots"`,
  });
}

async function servePinnedViewer(
  env: Env,
  requestUrl: string,
  id: string,
  token: string,
  versionValue: string,
): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);
  const version = parseArtifactVersionNumber(versionValue);
  const entry = version === null ? null : metadata?.versions.find((candidate) => candidate.version === version);

  if (!metadata || !entry) {
    return siteNotFound();
  }

  const url = new URL(requestUrl);
  const rawPath = entry.manifest ? manifestRawPath(id, token, entry) : `/raw/${encodeURIComponent(id)}/${encodeURIComponent(token)}/v/${entry.version}`;
  const sandbox = iframeSandboxAttribute(metadata.sandbox);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${escapeHtml(metadata.filename)} · Version ${entry.version}</title>
<style>
html,body{height:100%;margin:0;background:#fff}
iframe{display:block;width:100%;height:100%;border:0}
${VIEWER_BAR_CSS}
</style>
</head>
<body>
${scrubberBarHtml(id, token, metadata, entry.version)}${contentViewer(metadata, entry, rawPath, sandbox)}
<script>${scrubberBarScript(id, token, entry.version)}</script>
</body>
</html>`;

  return text(html, 200, {
    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; frame-src 'self'; img-src 'self'; media-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    Link: `<${url.origin}/robots.txt>; rel="robots"`,
  });
}

async function serveRaw(env: Env, id: string, token: string): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);

  if (!metadata) {
    return siteNotFound();
  }

  let object = await env.ARTIFACTS.get(metadata.contentKey);

  if (!object) {
    const currentMetadata = await readAuthorizedMetadata(env, id, token);

    if (!currentMetadata || currentMetadata.contentKey === metadata.contentKey) {
      return siteNotFound();
    }

    object = await env.ARTIFACTS.get(currentMetadata.contentKey);

    if (!object) {
      return siteNotFound();
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

async function servePinnedRaw(
  env: Env,
  id: string,
  token: string,
  versionValue: string,
): Promise<Response> {
  const metadata = await readAuthorizedMetadata(env, id, token);
  const version = parseArtifactVersionNumber(versionValue);
  const entry = version === null ? null : metadata?.versions.find((candidate) => candidate.version === version);

  if (!metadata || !entry) {
    return siteNotFound();
  }

  const object = await env.ARTIFACTS.get(entry.contentKey);

  if (!object) {
    return siteNotFound();
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

function parseUpdateTtl(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "never") {
    return null;
  }

  const normalized = typeof value === "number" ? String(value) : value;

  if (typeof normalized !== "string" || !/^[1-9]\d*$/.test(normalized)) {
    throw new Error("TTL must be a positive integer number of seconds or never.");
  }

  const parsed = Number(normalized);

  if (!Number.isSafeInteger(parsed) || parsed > MAX_TTL_SECONDS) {
    throw new Error("TTL must be 10 years or less.");
  }

  return parsed;
}

function updatedExpiration(current: string | null, ttlSeconds: number | null | undefined, updatedAt: string): string | null {
  if (ttlSeconds === undefined) {
    return current;
  }

  return ttlSeconds === null ? null : new Date(Date.parse(updatedAt) + ttlSeconds * 1000).toISOString();
}

function updatePayload(metadata: ArtifactMetadata): UpdatePayload {
  return {
    id: metadata.id,
    filename: metadata.filename,
    updatedAt: metadata.updatedAt,
    expiresAt: metadata.expiresAt,
    sandbox: metadata.sandbox,
    size: metadata.size,
    revision: metadata.revision,
    version: artifactHead(metadata).version,
    contentSha256: metadata.contentSha256,
    attributes: metadata.attributes,
  };
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

function iframePermissionsAttribute(mode: SandboxMode): string {
  if (mode === "strict") {
    return "";
  }

  return ` allow="${STANDARD_IFRAME_PERMISSIONS}"`;
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
  const attributes = { ...(metadata.attributes ?? {}) } as ArtifactAttributes & Record<string, unknown>;
  delete attributes.status;
  const updatedAt = metadata.updatedAt ?? metadata.createdAt;
  const contentKey = metadata.contentKey ?? htmlKey(metadata.id);
  const contentSha256 = metadata.contentSha256 ?? null;
  let versions =
    Array.isArray(metadata.versions) && metadata.versions.length > 0
      ? metadata.versions
      : [
          {
            version: 1,
            contentKey,
            contentSha256,
            size: metadata.size,
            createdAt: updatedAt,
          },
        ];
  if (!versions.some((entry) => entry.contentKey === contentKey)) {
    versions = appendArtifactVersion(versions, {
      version: (versions[versions.length - 1] as ArtifactVersion).version + 1,
      contentKey,
      contentSha256,
      size: metadata.size,
      createdAt: updatedAt,
    });
  }

  const storedCurrent = versions.find((entry) => entry.version === metadata.currentVersion);
  const currentEntry =
    storedCurrent && storedCurrent.contentKey === contentKey
      ? storedCurrent
      : ([...versions].reverse().find((entry) => entry.contentKey === contentKey) ??
        (versions[versions.length - 1] as ArtifactVersion));
  const currentVersion = currentEntry.version;

  return {
    ...metadata,
    updatedAt,
    revision: metadata.revision ?? 1,
    contentKey,
    contentSha256,
    versions,
    currentVersion,
    attributes,
  };
}

function artifactHead(metadata: ArtifactMetadata): ArtifactVersion {
  const head =
    metadata.versions.find((entry) => entry.version === metadata.currentVersion) ??
    metadata.versions[metadata.versions.length - 1];

  if (!head) {
    throw new Error(`Artifact ${metadata.id} has no version history.`);
  }

  return head;
}

function appendArtifactVersion(versions: ArtifactVersion[], version: ArtifactVersion): ArtifactVersion[] {
  return [...versions, version].slice(-MAX_ARTIFACT_VERSIONS);
}

function artifactVersionSummaries(metadata: ArtifactMetadata): ArtifactVersionSummary[] {
  const head = artifactHead(metadata);

  return metadata.versions.map((entry) => ({
    version: entry.version,
    size: entry.size,
    createdAt: entry.createdAt,
    contentSha256: entry.contentSha256,
    current: entry.version === head.version,
  }));
}

function parseArtifactVersionNumber(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const version = Number(value);

  return Number.isSafeInteger(version) ? version : null;
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

function siteNotFound(): Response {
  return text(NOT_FOUND_HTML, 404, {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    "Content-Type": "text/html; charset=utf-8",
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

interface UploadSession {
  id: string;
  baseEtag: string | null;
  expiresAt: number;
  filename: string;
  manifest: ContentManifest;
  sandbox: SandboxMode;
  ttlSeconds?: number | null | undefined;
  attributes: ArtifactAttributes;
}
function sessionKey(id: string, session: string): string { return `artifacts/${id}/content/session-${session}.json`; }
function manifestRawPath(id: string, token: string, entry: ArtifactVersion): string {
  return `/raw/${encodeURIComponent(id)}/${encodeURIComponent(token)}/v/${entry.version}/${filePathUrl(entry.manifest!.entrypoint)}`;
}
function contentViewer(metadata: ArtifactMetadata, entry: ArtifactVersion, path: string, sandbox: string): string {
  const file = entry.manifest?.files.find(f => f.path === entry.manifest?.entrypoint);
  if (!file || contentKind(file.contentType) === 'document') return `<iframe id="pagebin-frame"${sandbox}${iframePermissionsAttribute(metadata.sandbox)} src="${escapeHtml(path)}" title="${escapeHtml(entry.filename ?? metadata.filename)}"></iframe>`;
  const src = escapeHtml(path);
  const download = src.replace(/^\/raw\//, '/download/');
  const kind = contentKind(file.contentType);
  const media = kind === 'image' ? `<a href="${src}" target="_blank" rel="noreferrer"><img src="${src}" alt="${escapeHtml(metadata.attributes.title ?? entry.filename ?? metadata.filename)}"></a>` :
    kind === 'video' || kind === 'audio' ? `<${kind} controls playsinline preload="metadata" src="${src}"></${kind}><p>If this format cannot play in your browser, download the original.</p>` : `<h1>${escapeHtml(entry.filename ?? metadata.filename)}</h1>`;
  return `<main class="media-view">${media}<p>${escapeHtml(file.contentType)} · ${(file.size / 1048576).toFixed(2)} MiB</p><a href="${download}">Download original</a></main>`;
}
async function serveFile(request: Request, env: Env, metadata: ArtifactMetadata, entry: ArtifactVersion, encodedPath: string | undefined, download: boolean): Promise<Response> {
  let path: string;
  try { path = encodedPath === undefined ? entry.manifest?.entrypoint ?? metadata.filename : decodeURIComponent(encodedPath); }
  catch { return siteNotFound(); }
  if (!validPath(path)) return siteNotFound();
  const file = entry.manifest ? entry.manifest.files.find(f => f.path === path) : { objectKey: entry.contentKey, contentType: 'text/html; charset=utf-8', size: entry.size, path };
  if (!file) return siteNotFound();
  // An entry document must have a canonical filename URL so relative references stay version-pinned.
  if (!encodedPath && entry.manifest && !download && file.contentType.startsWith('text/html')) {
    const url = new URL(request.url);
    url.pathname = manifestRawPath(metadata.id, url.pathname.split('/')[3]!, entry);
    return new Response(null, { status: 307, headers: secureHeaders({ Location: url.toString() }) });
  }
  const head = await env.ARTIFACTS.head(file.objectKey);
  if (!head) return siteNotFound();
  const safeInline = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|ogg|mp4))$/.test(file.contentType) || /^(text\/(html|css|javascript|plain))(;|$)/.test(file.contentType);
  const headers = secureHeaders({
    'Content-Type': safeInline ? file.contentType : 'application/octet-stream',
    'Content-Disposition': `${download || !safeInline ? 'attachment' : 'inline'}; filename="download"; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!).replaceAll("'", '%27')}`,
    'Content-Length': String(head.size), 'Accept-Ranges': 'bytes', ETag: head.httpEtag,
    'Content-Security-Policy': file.contentType.startsWith('text/html') ? rawSandboxCsp(metadata.sandbox) : "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  });
  if (request.method === 'HEAD') return new Response(null, { headers });
  let range: { offset: number; length: number } | undefined;
  const requested = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  if (requested && (!ifRange || ifRange === head.httpEtag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(requested);
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, head.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(head.size - 1, Number(match[2])) : head.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= head.size) {
        headers.set('Content-Range', `bytes */${head.size}`); headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      range = { offset: start, length: end - start + 1 };
      headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`);
      headers.set('Content-Length', String(range.length));
    }
  }
  const object = await env.ARTIFACTS.get(file.objectKey, range ? { range } : undefined);
  if (!object) return siteNotFound();
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
async function uploadJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('Content-Length'));
  if (!Number.isSafeInteger(length) || length <= 0 || length > 256 * 1024) throw new Error('Upload metadata must be at most 256 KiB with Content-Length.');
  const body: unknown = await request.json();
  if (!isPlainObject(body)) throw new Error('Expected a JSON object.');
  return body;
}
async function routeUpload(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/uploads' && request.method === 'POST') {
    let body: Record<string, unknown>;
    try { body = await uploadJson(request); } catch (error) { return json({ error: String(error) }, 400); }
    const id = body.id === undefined ? randomBase64Url(16) : String(body.id);
    if (!isValidId(id)) return notFound();
    const stored = body.id === undefined ? null : await readStoredMetadata(env, id);
    if (body.id !== undefined && (!stored || stored.metadata.deletedAt || (stored.metadata.expiresAt && Date.parse(stored.metadata.expiresAt) <= Date.now()))) return notFound();
    const form = new FormData();
    form.set('sandbox', String(body.sandbox ?? stored?.metadata.sandbox ?? 'standard'));
    if (body.attributes !== undefined) form.set('attributes', JSON.stringify(body.attributes));
    // Parse lifetime with the existing update semantics, including explicit null = never.
    let ttlSeconds: number | null | undefined;
    let attributes: ArtifactAttributes;
    let sandbox: SandboxMode;
    try {
      ttlSeconds = body.ttlSeconds === undefined ? undefined : parseUpdateTtl(body.ttlSeconds === null ? 'never' : String(body.ttlSeconds));
      attributes = parseArtifactAttributes(form);
      const parsed = parsePublishOptions(form);
      if ('error' in parsed) throw new Error(parsed.error);
      sandbox = stored?.metadata.sandbox ?? parsed.sandbox;
    } catch (error) { return json({ error: String(error) }, 400); }
    const configuredLimit = Number(env.PAGEBIN_MAX_FILE_BYTES ?? FILE_LIMIT);
    const maxFileBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : FILE_LIMIT;
    const files = body.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > FILE_COUNT_LIMIT || typeof body.entrypoint !== 'string' || typeof body.filename !== 'string' || !validPath(body.filename) || body.filename.includes('/')) return json({ error: 'Invalid file manifest.' }, 400);
    const paths = new Set<string>();
    let total = 0;
    const valid: ContentFile[] = [];
    for (const value of files) {
      if (!isPlainObject(value) || typeof value.path !== 'string' || !validPath(value.path) || paths.has(value.path) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maxFileBytes) return json({ error: 'Invalid path, checksum, duplicate file, or file size limit exceeded.' }, 400);
      paths.add(value.path); total += value.size;
      valid.push({ path: value.path, sha256: value.sha256, size: value.size, contentType: contentType(value.path) });
    }
    if (total > BUNDLE_LIMIT || !paths.has(body.entrypoint)) return json({ error: 'Bundle exceeds 250 MiB or entrypoint is missing.' }, 400);
    const sessionId = randomBase64Url(16);
    const existing = stored?.metadata.versions.flatMap(v => v.manifest?.files ?? []) ?? [];
    const uploadFiles: StoredFile[] = [];
    const missing: string[] = [];
    for (const file of valid) {
      const reuse = existing.find(f => f.sha256 === file.sha256 && f.size === file.size);
      const reusable = reuse && await env.ARTIFACTS.head(reuse.objectKey);
      const objectKey = reusable ? reuse.objectKey : `artifacts/${id}/content/${sessionId}-${uploadFiles.length}`;
      if (!reusable) missing.push(file.path);
      uploadFiles.push({ ...file, objectKey });
    }
    const session: UploadSession = { id, baseEtag: stored?.etag ?? null, filename: body.filename, expiresAt: Date.now() + 30 * 60 * 1000, manifest: { entrypoint: body.entrypoint, files: uploadFiles, sha256: await sha256Hex(manifestSource(body.entrypoint, valid)) }, sandbox, ttlSeconds, attributes };
    await env.ARTIFACTS.put(sessionKey(id, sessionId), JSON.stringify(session));
    return json({ id, sessionId, missing }, 201);
  }
  const match = /^\/api\/uploads\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/(file|commit)$/.exec(url.pathname);
  if (!match) return notFound();
  const [, id, sessionId, action] = match;
  const object = await env.ARTIFACTS.get(sessionKey(id!, sessionId!));
  if (!object) return notFound();
  const session = JSON.parse(await object.text()) as UploadSession;
  if (session.expiresAt <= Date.now()) return json({ error: 'Upload session expired.' }, 410);
  if (action === 'file' && request.method === 'PUT') {
    const file = session.manifest.files.find(f => f.path === url.searchParams.get('path'));
    if (!file || !file.objectKey.startsWith(`artifacts/${id}/content/${sessionId}-`)) return notFound();
    if (request.headers.get('Content-Length') !== String(file.size)) return json({ error: 'Content-Length must match the manifest.' }, 400);
    // R2 validates the checksum while consuming the stream, without buffering it in the Worker.
    try { await env.ARTIFACTS.put(file.objectKey, request.body ?? new Uint8Array(), { sha256: file.sha256, httpMetadata: { contentType: file.contentType } }); }
    catch { return json({ error: 'File upload failed or checksum did not match. Retry this file.' }, 400); }
    return json({ uploaded: true });
  }
  if (action !== 'commit' || request.method !== 'POST') return notFound();
  const stored = await readStoredMetadata(env, id!);
  if ((stored?.etag ?? null) !== session.baseEtag || stored?.metadata.deletedAt || (stored?.metadata.expiresAt && Date.parse(stored.metadata.expiresAt) <= Date.now())) return conflict();
  for (const file of session.manifest.files) {
    const uploaded = await env.ARTIFACTS.head(file.objectKey);
    if (!uploaded || uploaded.size !== file.size) return json({ error: `Missing file: ${file.path}` }, 409);
  }
  const now = new Date().toISOString();
  const previous = stored?.metadata;
  const current = previous ? artifactHead(previous) : null;
  const same = previous?.contentSha256 === session.manifest.sha256 && current?.manifest?.sha256 === session.manifest.sha256;
  if (same && previous && session.filename === previous.filename && session.ttlSeconds === undefined && JSON.stringify({ ...previous.attributes, ...session.attributes }) === JSON.stringify(previous.attributes)) {
    await env.ARTIFACTS.delete(sessionKey(id!, sessionId!));
    return json({ ...updatePayload(previous), entrypoint: session.manifest.entrypoint, files: session.manifest.files.map(({objectKey: _, ...file}) => file) });
  }
  const version = same ? current!.version : (previous?.versions.at(-1)?.version ?? 0) + 1;
  const contentKey = same ? current!.contentKey : `artifacts/${id}/content/manifest-${sessionId}.json`;
  const size = session.manifest.files.reduce((sum, file) => sum + file.size, 0);
  const entry: ArtifactVersion = { version, contentKey, contentSha256: session.manifest.sha256, size, createdAt: now, filename: session.filename, manifest: session.manifest };
  const token = previous ? null : randomBase64Url(32);
  const metadata: ArtifactMetadata = {
    ...(previous ?? { id: id!, tokenHash: await sha256Hex(token!), createdAt: now, encryptedToken: await encryptViewerToken(env, id!, token!) ?? undefined }),
    filename: session.filename, updatedAt: now, expiresAt: updatedExpiration(previous?.expiresAt ?? null, session.ttlSeconds, now),
    sandbox: session.sandbox, size, revision: (previous?.revision ?? 0) + 1, contentKey, contentSha256: session.manifest.sha256,
    currentVersion: version, versions: same ? previous!.versions : appendArtifactVersion(previous?.versions ?? [], entry),
    attributes: { ...previous?.attributes, ...session.attributes },
  };
  if (!same) await env.ARTIFACTS.put(contentKey, JSON.stringify(session.manifest));
  const written = await env.ARTIFACTS.put(metadataKey(id!), JSON.stringify(metadata), { onlyIf: stored ? { etagMatches: stored.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  if (!written) return conflict();
  await env.ARTIFACTS.delete(sessionKey(id!, sessionId!));
  const viewerUrl = token ? `${publicOrigin(request, env)}/p/${id}/${token}` : null;
  const rawUrl = token ? `${publicOrigin(request, env)}${manifestRawPath(id!, token, entry)}` : null;
  return json({ ...updatePayload(metadata), ...(viewerUrl ? { url: viewerUrl, rawUrl, downloadUrl: rawUrl!.replace('/raw/', '/download/') } : {}), entrypoint: session.manifest.entrypoint, files: session.manifest.files.map(({objectKey: _, ...file}) => file) }, previous ? 200 : 201);
}
