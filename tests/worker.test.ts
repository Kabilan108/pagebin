import { describe, expect, test } from "bun:test";

import worker from "../worker/index";

interface StoredObject {
  bytes: ArrayBuffer;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  failHtmlDelete = false;
  failMetadataPut = false;
  invalidateNextConditionalPut = false;
  private etagSequence = 0;

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options: { onlyIf?: { etagMatches?: string } } = {},
  ): Promise<{ etag: string } | null> {
    if (this.failMetadataPut && key.endsWith("/metadata.json")) {
      throw new Error("metadata put failed");
    }

    if (this.invalidateNextConditionalPut && options.onlyIf?.etagMatches) {
      this.invalidateNextConditionalPut = false;
      const current = this.objects.get(key);

      if (current) {
        this.objects.set(key, { ...current, etag: this.nextEtag() });
      }
    }

    if (options.onlyIf?.etagMatches && this.objects.get(key)?.etag !== options.onlyIf.etagMatches) {
      return null;
    }

    const etag = this.nextEtag();

    if (typeof value === "string") {
      this.objects.set(key, { bytes: copyArrayBuffer(new TextEncoder().encode(value)), etag, uploaded: new Date() });
      return { etag };
    }

    if (ArrayBuffer.isView(value)) {
      this.objects.set(key, { bytes: copyArrayBuffer(value), etag, uploaded: new Date() });
      return { etag };
    }

    this.objects.set(key, { bytes: value, etag, uploaded: new Date() });
    return { etag };
  }

  async get(
    key: string,
  ): Promise<{
    body: ReadableStream<Uint8Array> | null;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    etag: string;
  } | null> {
    const object = this.objects.get(key);

    if (!object) {
      return null;
    }

    return {
      arrayBuffer: async () => object.bytes,
      body: new Response(object.bytes).body,
      etag: object.etag,
      text: async () => new TextDecoder().decode(object.bytes),
    };
  }

  async delete(key: string): Promise<void> {
    if (this.failHtmlDelete && (key.endsWith("/index.html") || key.includes("/content/"))) {
      throw new Error("html delete failed");
    }

    this.objects.delete(key);
  }

  async list(options: { cursor?: string; prefix?: string } = {}): Promise<{
    cursor?: string;
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
  }> {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .sort()
        .map((key) => ({ key, uploaded: this.objects.get(key)?.uploaded ?? new Date(0) })),
      truncated: false,
    };
  }

  private nextEtag(): string {
    this.etagSequence += 1;
    return `etag-${this.etagSequence}`;
  }
}

interface TestEnv {
  ARTIFACTS: MemoryR2Bucket;
  PAGEBIN_MAX_BYTES: string;
  PAGEBIN_PUBLISH_TOKEN: string;
  PAGEBIN_PUBLIC_ORIGIN?: string;
  PAGEBIN_CAPABILITY_KEY?: string;
  PAGEBIN_CAPABILITY_KEY_VERSION?: string;
  PAGEBIN_ACCESS_TEAM_DOMAIN?: string;
  PAGEBIN_ACCESS_AUD?: string;
}

describe("worker", () => {
  test("publishes, serves, rejects wrong tokens, and deletes artifacts", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const viewerResponse = await worker.fetch(new Request(published.url), env as never);
    const viewerHtml = await viewerResponse.text();

    expect(viewerResponse.status).toBe(200);
    expect(viewerHtml).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(viewerHtml).toContain("/version/");
    expect(viewerHtml).not.toContain("setInterval(");
    expect(viewerHtml).toContain("setTimeout(pagebinPoll, pagebinDelayMs)");
    expect(viewerHtml).toContain('document.addEventListener("visibilitychange"');
    expect(viewerResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");

    const rawUrl = published.url.replace("/p/", "/raw/");
    const rawResponse = await worker.fetch(new Request(rawUrl), env as never);

    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toContain("<script>");
    expect(rawResponse.headers.get("Cache-Control")).toContain("no-transform");
    expect(rawResponse.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-forms allow-popups allow-downloads");

    const wrongTokenResponse = await worker.fetch(new Request(`${published.url.slice(0, published.url.lastIndexOf("/") + 1)}wrong`), env as never);

    expect(wrongTokenResponse.status).toBe(404);

    const deleteResponse = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );

    expect(deleteResponse.status).toBe(200);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(404);
  });

  test("updates artifact content while preserving the existing viewer URL", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const updateResponse = await updateFixtureResponse(env, published.id, {
      contents: "<!doctype html><h1>updated</h1>",
      filename: "updated-plan.html",
    });
    const payload = (await updateResponse.json()) as {
      contentSha256: string;
      filename: string;
      id: string;
      revision: number;
      updatedAt: string;
      size: number;
    };
    const rawResponse = await worker.fetch(new Request(published.url.replace("/p/", "/raw/")), env as never);
    const versionResponse = await worker.fetch(
      new Request(published.url.replace("/p/", "/api/artifacts/").replace(/\/([^/]+)$/, "/version/$1")),
      env as never,
    );
    const versionPayload = (await versionResponse.json()) as {
      id: string;
      contentSha256: string;
      revision: number;
      updatedAt: string;
      size: number;
    };

    expect(updateResponse.status).toBe(200);
    expect(payload.id).toBe(published.id);
    expect(payload.filename).toBe("updated-plan.html");
    expect(typeof payload.updatedAt).toBe("string");
    expect(payload.size).toBe(31);
    expect(payload.revision).toBe(2);
    expect(payload.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toBe("<!doctype html><h1>updated</h1>");
    expect(versionResponse.status).toBe(200);
    expect(versionPayload).toEqual({
      id: published.id,
      contentSha256: payload.contentSha256,
      revision: 2,
      updatedAt: payload.updatedAt,
      size: 31,
    });
  });

  test("changes or removes TTL without uploading content", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const expiringResponse = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer publish-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 604800 }),
      }),
      env as never,
    );
    const expiring = (await expiringResponse.json()) as { expiresAt: string | null; revision: number };

    expect(expiringResponse.status).toBe(200);
    expect(expiring.expiresAt).not.toBeNull();
    expect(expiring.revision).toBe(2);

    const permanentResponse = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer publish-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: null }),
      }),
      env as never,
    );
    const permanent = (await permanentResponse.json()) as { expiresAt: string | null; revision: number };

    expect(permanentResponse.status).toBe(200);
    expect(permanent.expiresAt).toBeNull();
    expect(permanent.revision).toBe(3);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(200);
  });

  test("commits content and TTL as one conditional metadata update", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const response = await updateFixtureResponse(
      env,
      published.id,
      { contents: "<!doctype html><h1>expiring update</h1>", filename: "updated.html" },
      { ttlSeconds: "604800" },
    );
    const payload = (await response.json()) as { expiresAt: string | null; revision: number };

    expect(response.status).toBe(200);
    expect(payload.expiresAt).not.toBeNull();
    expect(payload.revision).toBe(2);
  });

  test("preserves expiration when a content update omits TTL", async () => {
    const env = createEnv();
    const published = await publishFixture(env, { ttlSeconds: "604800" });
    const beforeResponse = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );
    const before = (await beforeResponse.json()) as { expiresAt: string | null };
    const updateResponse = await updateFixtureResponse(env, published.id, {
      contents: "<!doctype html><h1>still expiring</h1>",
      filename: "updated.html",
    });
    const updated = (await updateResponse.json()) as { expiresAt: string | null };

    expect(updateResponse.status).toBe(200);
    expect(before.expiresAt).not.toBeNull();
    expect(updated.expiresAt).toBe(before.expiresAt);
  });

  test("requires publisher authorization to update artifacts", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const multipart = createMultipartBody({
      fields: {},
      file: {
        contents: "<!doctype html><h1>updated</h1>",
        filename: "updated-plan.html",
      },
    });
    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}/content`, {
        body: multipart.body,
        headers: {
          "Content-Length": String(multipart.byteLength),
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        },
        method: "PUT",
      }),
      env as never,
    );

    expect(response.status).toBe(401);
  });

  test("requires publisher authorization", async () => {
    const env: TestEnv = {
      ARTIFACTS: new MemoryR2Bucket(),
      PAGEBIN_MAX_BYTES: "10485760",
      PAGEBIN_PUBLISH_TOKEN: "publish-secret",
    };

    const response = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        method: "POST",
        body: new FormData(),
      }),
      env as never,
    );

    expect(response.status).toBe(401);
  });

  test("lists stored artifact metadata without view tokens", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const response = await worker.fetch(
      new Request("https://pagebin.test/api/artifacts", {
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );
    const payload = (await response.json()) as {
      artifacts: Array<{
        createdAt: string;
        expiresAt: string | null;
        filename: string;
        id: string;
        sandbox: string;
        size: number;
        revision: number;
        contentSha256: string;
      }>;
    };
    const token = new URL(published.url).pathname.split("/").at(-1);

    expect(response.status).toBe(200);
    expect(payload.artifacts).toHaveLength(1);
    expect(typeof payload.artifacts[0]?.createdAt).toBe("string");
    expect(payload.artifacts[0]).toEqual({
      attributes: {},
      createdAt: payload.artifacts[0]?.createdAt,
      expiresAt: null,
      filename: "plan.html",
      id: published.id,
      sandbox: "standard",
      size: 52,
      revision: 1,
      contentSha256: payload.artifacts[0]?.contentSha256,
    });
    expect(payload.artifacts[0]?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain(token ?? "");
  });

  test("returns one artifact's verification metadata to authorized clients", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );
    const payload = (await response.json()) as { id: string; revision: number; contentSha256: string };

    expect(response.status).toBe(200);
    expect(payload.id).toBe(published.id);
    expect(payload.revision).toBe(1);
    expect(payload.contentSha256).toMatch(/^[a-f0-9]{64}$/);

    const unauthorized = await worker.fetch(new Request(`https://pagebin.test/api/artifacts/${published.id}`), env as never);
    expect(unauthorized.status).toBe(401);
  });

  test("uses the display filename multipart field for stored metadata", async () => {
    const env = createEnv();
    const multipart = createMultipartBody({
      fields: {
        filename: "agent-report.md",
        sandbox: "standard",
      },
      file: {
        contents: "<!doctype html><h1>rendered markdown</h1>",
        filename: "agent-report.html",
      },
    });
    const publishResponse = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        method: "POST",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": String(multipart.byteLength),
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        },
        body: multipart.body,
      }),
      env as never,
    );
    const listResponse = await worker.fetch(
      new Request("https://pagebin.test/api/artifacts", {
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );
    const payload = (await listResponse.json()) as {
      artifacts: Array<{ filename: string }>;
    };

    expect(publishResponse.status).toBe(201);
    expect(payload.artifacts[0]?.filename).toBe("agent-report.md");
  });

  test("stores validated artifact attributes and merges them on update", async () => {
    const env = createEnv();
    const multipart = createMultipartBody({
      fields: {
        attributes: JSON.stringify({
          title: "Dashboard plan",
          project: "pagebin",
          sourceHost: "sietch",
          artifactType: "plan",
        }),
      },
      file: { contents: "<!doctype html><h1>plan</h1>", filename: "plan.html" },
    });
    const publishResponse = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        method: "POST",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": String(multipart.byteLength),
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        },
        body: multipart.body,
      }),
      env as never,
    );
    const published = (await publishResponse.json()) as PublishedArtifact & { attributes: Record<string, string> };

    expect(published.attributes).toMatchObject({ title: "Dashboard plan", project: "pagebin", sourceHost: "sietch" });

    const updateResponse = await updateFixtureResponse(
      env,
      published.id,
      { contents: "<!doctype html><h1>done</h1>", filename: "plan.html" },
      { attributes: JSON.stringify({ gitCommit: "abc123" }) },
    );
    const updated = (await updateResponse.json()) as { attributes: Record<string, string> };

    expect(updated.attributes).toMatchObject({
      title: "Dashboard plan",
      project: "pagebin",
      gitCommit: "abc123",
    });
  });

  test("rejects invalid artifact attributes on update with a client error", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const response = await updateFixtureResponse(
      env,
      published.id,
      { contents: "<!doctype html><h1>updated</h1>", filename: "plan.html" },
      { attributes: JSON.stringify({ artifactType: "not-a-real-type" }) },
    );

    expect(response.status).toBe(400);
  });

  test("rejects unknown artifact attributes", async () => {
    const env = createEnv();
    const multipart = createMultipartBody({
      fields: { attributes: JSON.stringify({ secretViewerToken: "nope" }) },
      file: { contents: "<!doctype html><h1>plan</h1>", filename: "plan.html" },
    });
    const response = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        method: "POST",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": String(multipart.byteLength),
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        },
        body: multipart.body,
      }),
      env as never,
    );

    expect(response.status).toBe(400);
  });

  test("accepts and discards legacy status attributes", async () => {
    const env = createEnv();
    const multipart = createMultipartBody({
      fields: { attributes: JSON.stringify({ title: "Legacy client", status: "active" }) },
      file: { contents: "<!doctype html><h1>legacy</h1>", filename: "legacy.html" },
    });
    const response = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        method: "POST",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": String(multipart.byteLength),
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        },
        body: multipart.body,
      }),
      env as never,
    );
    const payload = (await response.json()) as { attributes: Record<string, string> };

    expect(response.status).toBe(201);
    expect(payload.attributes).toEqual({ title: "Legacy client" });
  });

  test("uses the display filename multipart field when updating metadata", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const updateResponse = await updateFixtureResponse(
      env,
      published.id,
      {
        contents: "<!doctype html><h1>rendered markdown update</h1>",
        filename: "agent-report.html",
      },
      { filename: "agent-report.md" },
    );
    const updatePayload = (await updateResponse.json()) as { filename: string };
    const listResponse = await worker.fetch(
      new Request("https://pagebin.test/api/artifacts", {
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );
    const listPayload = (await listResponse.json()) as {
      artifacts: Array<{ filename: string }>;
    };

    expect(updateResponse.status).toBe(200);
    expect(updatePayload.filename).toBe("agent-report.md");
    expect(listPayload.artifacts[0]?.filename).toBe("agent-report.md");
  });

  test("requires publisher authorization to list artifacts", async () => {
    const env = createEnv();
    const response = await worker.fetch(new Request("https://pagebin.test/api/artifacts"), env as never);

    expect(response.status).toBe(401);
  });

  test("reissues a viewer URL and revokes the old token", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}/reissue`, {
        method: "POST",
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );
    const payload = (await response.json()) as {
      expiresAt: string | null;
      id: string;
      sandbox: string;
      url: string;
      revision: number;
    };

    expect(response.status).toBe(200);
    expect(payload.id).toBe(published.id);
    expect(payload.url).toStartWith(`https://pagebin.test/p/${published.id}/`);
    expect(payload.url).not.toBe(published.url);
    expect(payload.expiresAt).toBeNull();
    expect(payload.sandbox).toBe("standard");
    expect(payload.revision).toBe(2);
    expect((await worker.fetch(new Request(payload.url), env as never)).status).toBe(200);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(404);
  });

  test("requires publisher authorization to reissue artifacts", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}/reissue`, {
        method: "POST",
      }),
      env as never,
    );

    expect(response.status).toBe(401);
  });

  test("does not reissue expired artifacts", async () => {
    const env = createEnv();
    const originalDateNow = Date.now;
    const published = await publishFixture(env, { ttlSeconds: "1" });

    try {
      Date.now = () => originalDateNow() + 2000;

      const response = await worker.fetch(
        new Request(`https://pagebin.test/api/artifacts/${published.id}/reissue`, {
          method: "POST",
          headers: { Authorization: "Bearer publish-secret" },
        }),
        env as never,
      );

      expect(response.status).toBe(410);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("strict sandbox disables iframe permissions and raw CSP allowances", async () => {
    const env = createEnv();
    const published = await publishFixture(env, { sandbox: "strict" });
    const viewerResponse = await worker.fetch(new Request(published.url), env as never);
    const viewerHtml = await viewerResponse.text();
    const rawResponse = await worker.fetch(new Request(published.url.replace("/p/", "/raw/")), env as never);

    expect(viewerHtml).toContain(" sandbox ");
    expect(viewerHtml).not.toContain("allow-scripts");
    expect(rawResponse.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  test("expired and unknown artifacts return 404", async () => {
    const env = createEnv();
    const originalDateNow = Date.now;
    const published = await publishFixture(env, { ttlSeconds: "1" });

    try {
      Date.now = () => originalDateNow() + 2000;
      expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(404);
      expect((await worker.fetch(new Request("https://pagebin.test/p/unknownunknownunknown/t"), env as never)).status).toBe(404);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("scheduled cleanup deletes expired artifacts and keeps active artifacts", async () => {
    const env = createEnv();
    const originalDateNow = Date.now;
    const expired = await publishFixture(env, { ttlSeconds: "1" });
    const active = await publishFixture(env, { ttlSeconds: "1209600" });

    try {
      Date.now = () => originalDateNow() + 2000;

      await worker.scheduled({} as ScheduledController, env as never, {} as ExecutionContext);

      expect(await env.ARTIFACTS.get(`artifacts/${expired.id}/metadata.json`)).toBeNull();
      expect(await env.ARTIFACTS.get(`artifacts/${expired.id}/index.html`)).toBeNull();
      expect(await env.ARTIFACTS.get(`artifacts/${active.id}/metadata.json`)).not.toBeNull();
      expect(await env.ARTIFACTS.get(`artifacts/${active.id}/index.html`)).not.toBeNull();
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("scheduled cleanup keeps metadata for retry if HTML deletion fails", async () => {
    const env = createEnv();
    const originalDateNow = Date.now;
    const expired = await publishFixture(env, { ttlSeconds: "1" });

    env.ARTIFACTS.failHtmlDelete = true;

    try {
      Date.now = () => originalDateNow() + 2000;

      await withSuppressedConsoleError(() => worker.scheduled({} as ScheduledController, env as never, {} as ExecutionContext));

      expect(await env.ARTIFACTS.get(`artifacts/${expired.id}/metadata.json`)).not.toBeNull();
      expect(await env.ARTIFACTS.get(`artifacts/${expired.id}/index.html`)).not.toBeNull();
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("metadata stores only the token hash", async () => {
    const env = createEnv();
    const published = await publishFixture(env);
    const metadata = await env.ARTIFACTS.get(`artifacts/${published.id}/metadata.json`);
    const token = new URL(published.url).pathname.split("/").at(-1);
    const metadataText = await metadata?.text();

    expect(metadataText).toContain("tokenHash");
    expect(metadataText).not.toContain(token ?? "");
  });

  test("encrypts viewer-token recovery and exposes it only through the authorized dashboard", async () => {
    const env = createEnv({
      PAGEBIN_CAPABILITY_KEY: base64UrlForTest(new TextEncoder().encode("k".repeat(32))),
      PAGEBIN_CAPABILITY_KEY_VERSION: "test-v1",
      PAGEBIN_PUBLIC_ORIGIN: "https://page-bin.com",
    });
    const published = await publishFixture(env);
    const token = new URL(published.url).pathname.split("/").at(-1) ?? "";
    const metadata = await env.ARTIFACTS.get(`artifacts/${published.id}/metadata.json`);
    const metadataText = await metadata?.text();

    expect(published.url).toStartWith("https://page-bin.com/p/");
    expect(metadataText).toContain("encryptedToken");
    expect(metadataText).not.toContain(token);

    const dashboard = await worker.fetch(new Request("http://localhost/"), env as never);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("PageBin artifacts");

    const listResponse = await worker.fetch(new Request("http://localhost/api/dashboard/artifacts"), env as never);
    const list = (await listResponse.json()) as { artifacts: Array<{ id: string; linkRecoverable: boolean }> };
    expect(list.artifacts[0]).toMatchObject({ id: published.id, linkRecoverable: true });

    const linkResponse = await worker.fetch(
      new Request(`http://localhost/api/dashboard/artifacts/${published.id}/link`),
      env as never,
    );
    const link = (await linkResponse.json()) as { url: string };
    expect(link.url).toBe(published.url);

    const openResponse = await worker.fetch(
      new Request(`http://localhost/api/dashboard/artifacts/${published.id}/open`),
      env as never,
    );
    expect(openResponse.status).toBe(303);
    expect(openResponse.headers.get("Location")).toBe(published.url);

    const reissueResponse = await worker.fetch(
      new Request(`http://localhost/api/dashboard/artifacts/${published.id}/reissue`, {
        method: "POST",
        headers: { "X-PageBin-Dashboard": "1" },
      }),
      env as never,
    );
    const reissued = (await reissueResponse.json()) as { url: string };
    expect(reissued.url).not.toBe(published.url);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(404);
    expect((await worker.fetch(new Request(reissued.url), env as never)).status).toBe(200);

    const missingCsrf = await worker.fetch(
      new Request(`http://localhost/api/dashboard/artifacts/${published.id}/reissue`, { method: "POST" }),
      env as never,
    );
    expect(missingCsrf.status).toBe(403);
  });

  test("omits expired artifacts from the dashboard index", async () => {
    const env = createEnv();
    const originalDateNow = Date.now;
    const expired = await publishFixture(env, { ttlSeconds: "1" });
    const active = await publishFixture(env);

    try {
      Date.now = () => originalDateNow() + 2000;
      const response = await worker.fetch(new Request("http://localhost/api/dashboard/artifacts"), env as never);
      const payload = (await response.json()) as { artifacts: Array<{ id: string }> };

      expect(response.status).toBe(200);
      expect(payload.artifacts.map((artifact) => artifact.id)).toEqual([active.id]);
      expect(payload.artifacts.some((artifact) => artifact.id === expired.id)).toBe(false);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("keeps public, API, and admin origins isolated", async () => {
    const env = createEnv();

    expect((await worker.fetch(new Request("https://page-bin.com/api/artifacts"), env as never)).status).toBe(421);
    expect(
      (
        await worker.fetch(
          new Request("https://page-bin.com/api/artifacts/unknownunknown12/version/unknown-token"),
          env as never,
        )
      ).status,
    ).toBe(404);
    expect((await worker.fetch(new Request("https://api.page-bin.com/p/unknownunknownunknown/token"), env as never)).status).toBe(421);
    expect(
      (
        await worker.fetch(
          new Request("https://admin.page-bin.com/api/publish", {
            method: "POST",
            headers: { Authorization: "Bearer publish-secret" },
          }),
          env as never,
        )
      ).status,
    ).toBe(404);
    expect((await worker.fetch(new Request("https://admin.page-bin.com/"), env as never)).status).toBe(401);
  });

  test("rejects invalid publish requests with client errors", async () => {
    const env = createEnv();
    const unsupportedResponse = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        body: "{}",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": "2",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      env as never,
    );
    const oversizedResponse = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        body: "x",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": "10551297",
          "Content-Type": "multipart/form-data; boundary=x",
        },
        method: "POST",
      }),
      env as never,
    );
    const invalidTtlResponse = await publishFixtureResponse(env, { ttlSeconds: "999999999999999999999999" });

    expect(unsupportedResponse.status).toBe(415);
    expect(oversizedResponse.status).toBe(413);
    expect(invalidTtlResponse.status).toBe(400);
  });

  test("rejects direct markdown uploads at the worker boundary", async () => {
    const env = createEnv();
    const publishMultipart = createMultipartBody({
      fields: { sandbox: "standard" },
      file: {
        contents: "# Not pre-rendered",
        filename: "agent-report.md",
      },
    });
    const publishResponse = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        body: publishMultipart.body,
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": String(publishMultipart.byteLength),
          "Content-Type": `multipart/form-data; boundary=${publishMultipart.boundary}`,
        },
        method: "POST",
      }),
      env as never,
    );
    const published = await publishFixture(env);
    const updateResponse = await updateFixtureResponse(env, published.id, {
      contents: "# Not pre-rendered",
      filename: "agent-report.md",
    });

    expect(publishResponse.status).toBe(400);
    expect(updateResponse.status).toBe(400);
  });

  test("rejects publish requests without a bounded content length", async () => {
    const env = createEnv();
    const request = new Request("https://pagebin.test/api/publish", {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("body"));
          controller.close();
        },
      }),
      headers: {
        Authorization: "Bearer publish-secret",
        "Content-Type": "multipart/form-data; boundary=x",
      },
      method: "POST",
    });
    const response = await worker.fetch(request, env as never);

    expect(response.status).toBe(413);
  });

  test("clamps configured upload limit to the hard 10 MB cap", async () => {
    const env = createEnv({ PAGEBIN_MAX_BYTES: "20971520" });

    const response = await worker.fetch(
      new Request("https://pagebin.test/api/publish", {
        body: "x",
        headers: {
          Authorization: "Bearer publish-secret",
          "Content-Length": "10551297",
          "Content-Type": "multipart/form-data; boundary=x",
        },
        method: "POST",
      }),
      env as never,
    );

    expect(response.status).toBe(413);
  });

  test("cleans up HTML if metadata persistence fails", async () => {
    const env = createEnv();

    env.ARTIFACTS.failMetadataPut = true;

    const response = await withSuppressedConsoleError(() => publishFixtureResponse(env));

    expect(response.status).toBe(500);
    expect([...env.ARTIFACTS.objects.keys()].some((key) => key.endsWith("/index.html"))).toBe(false);
  });

  test("rolls back updated HTML if update metadata persistence fails", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    env.ARTIFACTS.failMetadataPut = true;

    const response = await withSuppressedConsoleError(() =>
      updateFixtureResponse(env, published.id, {
        contents: "<!doctype html><h1>updated</h1>",
        filename: "updated-plan.html",
      }),
    );
    const rawResponse = await worker.fetch(new Request(published.url.replace("/p/", "/raw/")), env as never);

    expect(response.status).toBe(500);
    expect(await rawResponse.text()).toContain("<script>globalThis.ok = true</script>");
  });

  test("rejects a concurrent update without changing the current content", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    env.ARTIFACTS.invalidateNextConditionalPut = true;

    const response = await updateFixtureResponse(env, published.id, {
      contents: "<!doctype html><h1>racing update</h1>",
      filename: "racing-update.html",
    });
    const rawResponse = await worker.fetch(new Request(published.url.replace("/p/", "/raw/")), env as never);

    expect(response.status).toBe(409);
    expect(await rawResponse.text()).toContain("<script>globalThis.ok = true</script>");
    expect([...env.ARTIFACTS.objects.keys()].filter((key) => key.includes("/content/"))).toHaveLength(0);
  });

  test("rejects a concurrent TTL update without changing expiration", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    env.ARTIFACTS.invalidateNextConditionalPut = true;

    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer publish-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 604800 }),
      }),
      env as never,
    );
    const metadata = await env.ARTIFACTS.get(`artifacts/${published.id}/metadata.json`);
    const stored = JSON.parse((await metadata?.text()) ?? "{}") as { expiresAt: string | null };

    expect(response.status).toBe(409);
    expect(stored.expiresAt).toBeNull();
  });

  test("rejects concurrent reissue and preserves the current viewer token", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    env.ARTIFACTS.invalidateNextConditionalPut = true;

    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}/reissue`, {
        method: "POST",
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );

    expect(response.status).toBe(409);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(200);
  });

  test("rejects concurrent deletion without revoking the artifact", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    env.ARTIFACTS.invalidateNextConditionalPut = true;

    const response = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );

    expect(response.status).toBe(409);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(200);
  });

  test("migrates legacy metadata through serve, update, and delete", async () => {
    const env = createEnv();
    const id = "legacylegacy1234";
    const token = "legacy-view-token";
    const createdAt = new Date().toISOString();

    await env.ARTIFACTS.put(`artifacts/${id}/index.html`, "<!doctype html><h1>legacy</h1>");
    await env.ARTIFACTS.put(
      `artifacts/${id}/metadata.json`,
      JSON.stringify({
        id,
        filename: "legacy.html",
        tokenHash: await sha256ForTest(token),
        createdAt,
        updatedAt: createdAt,
        expiresAt: null,
        sandbox: "standard",
        size: 31,
      }),
    );

    const viewerUrl = `https://pagebin.test/p/${id}/${token}`;
    expect((await worker.fetch(new Request(viewerUrl), env as never)).status).toBe(200);
    expect(await (await worker.fetch(new Request(viewerUrl.replace("/p/", "/raw/")), env as never)).text()).toContain("legacy");

    const updateResponse = await updateFixtureResponse(env, id, {
      contents: "<!doctype html><h1>modernized</h1>",
      filename: "modernized.html",
    });
    const updatePayload = (await updateResponse.json()) as { revision: number; contentSha256: string };

    expect(updateResponse.status).toBe(200);
    expect(updatePayload.revision).toBe(2);
    expect(updatePayload.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await (await worker.fetch(new Request(viewerUrl.replace("/p/", "/raw/")), env as never)).text()).toContain("modernized");

    const deleteResponse = await worker.fetch(
      new Request(`https://pagebin.test/api/artifacts/${id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env as never,
    );

    expect(deleteResponse.status).toBe(200);
    expect([...env.ARTIFACTS.objects.keys()].filter((key) => key.startsWith(`artifacts/${id}/`))).toHaveLength(0);
  });

  test("scheduled cleanup removes superseded content after the grace period", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    await updateFixtureResponse(env, published.id, {
      contents: "<!doctype html><h1>current</h1>",
      filename: "current.html",
    });

    const legacyKey = `artifacts/${published.id}/index.html`;
    const legacyObject = env.ARTIFACTS.objects.get(legacyKey);
    expect(legacyObject).toBeDefined();

    if (legacyObject) {
      legacyObject.uploaded = new Date(Date.now() - 2 * 60 * 60 * 1000);
    }

    await worker.scheduled({} as ScheduledController, env as never, {} as ExecutionContext);

    expect(await env.ARTIFACTS.get(legacyKey)).toBeNull();
    expect(await (await worker.fetch(new Request(published.url.replace("/p/", "/raw/")), env as never)).text()).toContain("current");
  });

  test("revokes metadata before deleting HTML", async () => {
    const env = createEnv();
    const published = await publishFixture(env);

    env.ARTIFACTS.failHtmlDelete = true;

    const deleteResponse = await withSuppressedConsoleError(() =>
      worker.fetch(
        new Request(`https://pagebin.test/api/artifacts/${published.id}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer publish-secret" },
        }),
        env as never,
      ),
    );

    expect(deleteResponse.status).toBe(500);
    expect((await worker.fetch(new Request(published.url), env as never)).status).toBe(404);

    env.ARTIFACTS.failHtmlDelete = false;
    await worker.scheduled({} as ScheduledController, env as never, {} as ExecutionContext);

    expect(await env.ARTIFACTS.get(`artifacts/${published.id}/metadata.json`)).toBeNull();
    expect(await env.ARTIFACTS.get(`artifacts/${published.id}/index.html`)).toBeNull();
  });
});

interface PublishFixtureOptions {
  sandbox?: "standard" | "strict";
  ttlSeconds?: string;
}

interface PublishedArtifact {
  id: string;
  url: string;
}

function createEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    ARTIFACTS: new MemoryR2Bucket(),
    PAGEBIN_MAX_BYTES: "10485760",
    PAGEBIN_PUBLISH_TOKEN: "publish-secret",
    ...overrides,
  };
}

async function publishFixture(env: TestEnv, options: PublishFixtureOptions = {}): Promise<PublishedArtifact> {
  const response = await publishFixtureResponse(env, options);

  expect(response.status).toBe(201);

  return (await response.json()) as PublishedArtifact;
}

async function publishFixtureResponse(env: TestEnv, options: PublishFixtureOptions = {}): Promise<Response> {
  const multipart = createMultipartBody({
    fields: {
      sandbox: options.sandbox ?? "standard",
      ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
    },
    file: {
      contents: "<!doctype html><script>globalThis.ok = true</script>",
      filename: "plan.html",
    },
  });

  return worker.fetch(
    new Request("https://pagebin.test/api/publish", {
      method: "POST",
      headers: {
        Authorization: "Bearer publish-secret",
        "Content-Length": String(multipart.byteLength),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    }),
    env as never,
  );
}

async function updateFixtureResponse(
  env: TestEnv,
  id: string,
  file: { contents: string; filename: string },
  fields: Record<string, string> = {},
): Promise<Response> {
  const multipart = createMultipartBody({
    fields,
    file,
  });

  return worker.fetch(
    new Request(`https://pagebin.test/api/artifacts/${id}/content`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer publish-secret",
        "Content-Length": String(multipart.byteLength),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    }),
    env as never,
  );
}

function createMultipartBody(input: {
  fields: Record<string, string>;
  file: { contents: string; filename: string };
}): { body: string; boundary: string; byteLength: number } {
  const boundary = "pagebin-test-boundary";
  const chunks = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${input.file.filename}"`,
    "Content-Type: text/html",
    "",
    input.file.contents,
  ];

  for (const [name, value] of Object.entries(input.fields)) {
    chunks.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, "", value);
  }

  chunks.push(`--${boundary}--`, "");

  const body = chunks.join("\r\n");

  return {
    body,
    boundary,
    byteLength: new TextEncoder().encode(body).byteLength,
  };
}

function copyArrayBuffer(value: ArrayBufferView): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function sha256ForTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlForTest(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function withSuppressedConsoleError<T>(callback: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;

  console.error = () => undefined;

  try {
    return await callback();
  } finally {
    console.error = originalConsoleError;
  }
}
