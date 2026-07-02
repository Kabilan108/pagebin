import { describe, expect, test } from "bun:test";

import worker from "../worker/index";

interface StoredObject {
  bytes: ArrayBuffer;
}

class MemoryR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  failHtmlDelete = false;
  failMetadataPut = false;

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.failMetadataPut && key.endsWith("/metadata.json")) {
      throw new Error("metadata put failed");
    }

    if (typeof value === "string") {
      this.objects.set(key, { bytes: copyArrayBuffer(new TextEncoder().encode(value)) });
      return;
    }

    if (ArrayBuffer.isView(value)) {
      this.objects.set(key, { bytes: copyArrayBuffer(value) });
      return;
    }

    this.objects.set(key, { bytes: value });
  }

  async get(
    key: string,
  ): Promise<{ body: ReadableStream<Uint8Array> | null; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const object = this.objects.get(key);

    if (!object) {
      return null;
    }

    return {
      arrayBuffer: async () => object.bytes,
      body: new Response(object.bytes).body,
      text: async () => new TextDecoder().decode(object.bytes),
    };
  }

  async delete(key: string): Promise<void> {
    if (this.failHtmlDelete && key.endsWith("/index.html")) {
      throw new Error("html delete failed");
    }

    this.objects.delete(key);
  }

  async list(options: { cursor?: string; prefix?: string } = {}): Promise<{
    cursor?: string;
    objects: { key: string }[];
    truncated: boolean;
  }> {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .sort()
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

interface TestEnv {
  ARTIFACTS: MemoryR2Bucket;
  PAGEBIN_MAX_BYTES: string;
  PAGEBIN_PUBLISH_TOKEN: string;
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
    expect(viewerHtml).toContain("setInterval(pagebinPoll, 1000)");
    expect(viewerResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");

    const rawUrl = published.url.replace("/p/", "/raw/");
    const rawResponse = await worker.fetch(new Request(rawUrl), env as never);

    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toContain("<script>");
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
      filename: string;
      id: string;
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
      updatedAt: string;
      size: number;
    };

    expect(updateResponse.status).toBe(200);
    expect(payload.id).toBe(published.id);
    expect(payload.filename).toBe("updated-plan.html");
    expect(typeof payload.updatedAt).toBe("string");
    expect(payload.size).toBe(31);
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toBe("<!doctype html><h1>updated</h1>");
    expect(versionResponse.status).toBe(200);
    expect(versionPayload).toEqual({
      id: published.id,
      updatedAt: payload.updatedAt,
      size: 31,
    });
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
      }>;
    };
    const token = new URL(published.url).pathname.split("/").at(-1);

    expect(response.status).toBe(200);
    expect(payload.artifacts).toHaveLength(1);
    expect(typeof payload.artifacts[0]?.createdAt).toBe("string");
    expect(payload.artifacts[0]).toEqual({
      createdAt: payload.artifacts[0]?.createdAt,
      expiresAt: null,
      filename: "plan.html",
      id: published.id,
      sandbox: "standard",
      size: 52,
    });
    expect(JSON.stringify(payload)).not.toContain(token ?? "");
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
    };

    expect(response.status).toBe(200);
    expect(payload.id).toBe(published.id);
    expect(payload.url).toStartWith(`https://pagebin.test/p/${published.id}/`);
    expect(payload.url).not.toBe(published.url);
    expect(payload.expiresAt).toBeNull();
    expect(payload.sandbox).toBe("standard");
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

async function withSuppressedConsoleError<T>(callback: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;

  console.error = () => undefined;

  try {
    return await callback();
  } finally {
    console.error = originalConsoleError;
  }
}
