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

  test("strict sandbox disables iframe permissions and raw CSP allowances", async () => {
    const env = createEnv();
    const published = await publishFixture(env, { sandbox: "strict" });
    const viewerResponse = await worker.fetch(new Request(published.url), env as never);
    const viewerHtml = await viewerResponse.text();
    const rawResponse = await worker.fetch(new Request(published.url.replace("/p/", "/raw/")), env as never);

    expect(viewerHtml).toContain("<iframe sandbox ");
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
