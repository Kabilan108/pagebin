import { describe, expect, test } from "bun:test";

import { formatReviewMarkdown, type ReviewFormatInput } from "../shared/review";
import worker from "../worker/index";
import { embeddedFunction, frameScriptTag } from "../worker/review-frame";
import {
  createSerialSaver,
  embeddedFormatterSource,
  mergeLoaded,
  reviewViewerScript,
} from "../worker/review-ui";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
}

interface PutOptions {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
}

class MemoryBucket {
  private readonly objects = new Map<string, StoredObject>();
  private sequence = 0;

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options: PutOptions = {},
  ): Promise<{ etag: string } | null> {
    const current = this.objects.get(key);

    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;

    if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;

    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const etag = `etag-${++this.sequence}`;

    this.objects.set(key, { bytes, etag });

    return { etag };
  }

  async head(key: string) {
    const object = this.objects.get(key);

    return object
      ? { size: object.bytes.byteLength, etag: object.etag, httpEtag: `"${object.etag}"` }
      : null;
  }

  async get(key: string) {
    const object = this.objects.get(key);

    if (!object) return null;

    return {
      body: new Response(object.bytes).body,
      etag: object.etag,
      text: async () => new TextDecoder().decode(object.bytes),
      arrayBuffer: async () => object.bytes.slice().buffer,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: { prefix?: string } = {}) {
    const objects = [...this.objects.keys()].flatMap((key) =>
      !options.prefix || key.startsWith(options.prefix) ? [{ key, uploaded: new Date() }] : [],
    );

    return { objects, truncated: false };
  }
}

interface TestEnv {
  ARTIFACTS: MemoryBucket;
  PAGEBIN_MAX_BYTES: string;
  PAGEBIN_PUBLISH_TOKEN: string;
  PAGEBIN_PUBLIC_ORIGIN: string;
  PAGEBIN_USERCONTENT_ORIGIN?: string;
}

interface Published {
  id: string;
  url: string;
}

const ORIGIN = "https://pagebin.test";

const createEnv = (usercontent: boolean): TestEnv => ({
  ARTIFACTS: new MemoryBucket(),
  PAGEBIN_MAX_BYTES: "10485760",
  PAGEBIN_PUBLISH_TOKEN: "publish-secret",
  PAGEBIN_PUBLIC_ORIGIN: ORIGIN,
  ...(usercontent ? { PAGEBIN_USERCONTENT_ORIGIN: "https://{label}.usercontent.test" } : {}),
});

const fetchWorker = (env: TestEnv, request: Request): Promise<Response> =>
  worker.fetch(request, env as never);

async function authorized(
  env: TestEnv,
  method: string,
  path: string,
  body: BodyInit | FormData,
): Promise<Response> {
  const draft = new Response(body);
  // Bun drops the generated multipart Content-Type once the body has been read.
  const contentType = draft.headers.get("Content-Type");
  const bytes = await draft.arrayBuffer();

  const headers = new Headers({
    Authorization: "Bearer publish-secret",
    "Content-Length": String(bytes.byteLength),
  });

  if (contentType) headers.set("Content-Type", contentType);

  return fetchWorker(env, new Request(`${ORIGIN}${path}`, { method, headers, body: bytes }));
}

const DOCUMENT =
  "<!doctype html><html><head><title>t</title></head><body><p>Hello</p></body></html>";

async function publishHtml(
  env: TestEnv,
  sandbox: "standard" | "strict" = "standard",
): Promise<Published> {
  const form = new FormData();

  form.set("sandbox", sandbox);
  form.set("attributes", JSON.stringify({ title: "Plan </script> title" }));
  form.set("file", new File([DOCUMENT], "plan.html", { type: "text/html" }));

  const response = await authorized(env, "POST", "/api/publish", form);

  expect(response.status).toBe(201);

  return (await response.json()) as Published;
}

async function updateHtml(env: TestEnv, id: string): Promise<void> {
  const form = new FormData();

  form.set("file", new File([DOCUMENT.replace("Hello", "Hello again")], "plan.html"));

  expect((await authorized(env, "PUT", `/api/artifacts/${id}/content`, form)).status).toBe(200);
}

async function publishFile(env: TestEnv, path: string, data: string): Promise<Published> {
  const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const size = new TextEncoder().encode(data).byteLength;

  const begin = await authorized(
    env,
    "POST",
    "/api/uploads",
    JSON.stringify({ entrypoint: path, filename: path, files: [{ path, size, sha256 }] }),
  );

  expect(begin.status).toBe(201);
  const session = (await begin.json()) as { id: string; sessionId: string };
  const base = `/api/uploads/${session.id}/${session.sessionId}`;

  const put = await authorized(env, "PUT", `${base}/file?path=${encodeURIComponent(path)}`, data);

  expect(put.status).toBe(200);
  const commit = await authorized(env, "POST", `${base}/commit`, "");

  expect(commit.status).toBe(201);

  return (await commit.json()) as Published;
}

const viewerHtml = async (env: TestEnv, url: string): Promise<string> => {
  const response = await fetchWorker(env, new Request(url));

  expect(response.status).toBe(200);

  return response.text();
};

const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

const REVIEW_MARKERS = [
  'id="pb-panel"',
  'id="pb-count-btn"',
  'id="pb-fab"',
  'id="pb-review-config"',
];

const reviewConfig = (
  html: string,
): { version: number; frameOrigin: string | null; title: string } => {
  const json = /<script type="application\/json" id="pb-review-config">([^<]*)<\/script>/.exec(
    html,
  );

  expect(json?.[1]).toBeDefined();

  return JSON.parse(json![1]!);
};

const fixture: ReviewFormatInput = {
  artifact: { id: "k7m2q9", title: "Plan", filename: "plan.html", version: 2 },
  listsUnanswered: true,
  decisions: [
    {
      id: "limit",
      question: "Page size?",
      controls: [
        { name: "limit", type: "select", default: "50" },
        { name: "limit:note", type: "textarea", default: "" },
      ],
      values: { limit: "100", "limit:note": 'keep it "small"' },
      interacted: true,
      answeredVersion: 1,
      updatedAt: "2026-10-06T00:00:00.000Z",
      orphaned: false,
      notOffered: true,
    },
  ],
  comments: [
    {
      id: "c1",
      anchor: { quote: "Hello", prefix: "", suffix: "", version: 2 },
      body: "why?",
      status: "open",
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      found: true,
    },
    {
      id: "c2",
      anchor: { quote: "gone", prefix: "", suffix: "", version: 1 },
      body: "old",
      status: "open",
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      found: false,
    },
  ],
};

describe("review layer in the viewer", () => {
  test("shows on current and pinned viewers of standard HTML documents", async () => {
    const env = createEnv(true);
    const published = await publishHtml(env);

    await updateHtml(env, published.id);

    const current = await viewerHtml(env, published.url);
    const pinned = await viewerHtml(env, `${published.url}/v/1`);

    for (const html of [current, pinned]) {
      for (const marker of REVIEW_MARKERS) expect(html).toContain(marker);
      expect(html).toContain("interactive-widget=resizes-content");
      expect(html).toContain("height:100dvh");
    }

    expect(reviewConfig(current).version).toBe(2);
    expect(reviewConfig(pinned).version).toBe(1);
    expect(reviewConfig(current).title).toBe("Plan </script> title");
    expect(current).not.toContain("Plan </script> title");
  });

  test("is absent for strict documents and for non-document files", async () => {
    const env = createEnv(true);

    const urls = [
      (await publishHtml(env, "strict")).url,
      (await publishFile(env, "report.pdf", "%PDF-1.7")).url,
      (await publishFile(env, "chart.png", "png-bytes")).url,
      (await publishFile(env, "clip.mp4", "mp4-bytes")).url,
      (await publishFile(env, "note.mp3", "mp3-bytes")).url,
      (await publishFile(env, "data.csv", "a,b")).url,
    ];

    for (const url of urls) {
      for (const html of [await viewerHtml(env, url), await viewerHtml(env, `${url}/v/1`)]) {
        for (const marker of REVIEW_MARKERS) expect(html).not.toContain(marker);
        expect(html).toContain("interactive-widget=resizes-content");
      }
    }
  });

  test("keeps the viewer CSP's connect-src on its own origin", async () => {
    const env = createEnv(true);
    const published = await publishHtml(env);
    const response = await fetchWorker(env, new Request(published.url));

    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self';");
  });

  test("passes the usercontent frame origin to the viewer, or null in fallback mode", async () => {
    const usercontent = createEnv(true);
    const fallback = createEnv(false);
    const isolated = await publishHtml(usercontent);
    const shared = await publishHtml(fallback);

    expect(reviewConfig(await viewerHtml(usercontent, isolated.url)).frameOrigin).toMatch(
      /^https:\/\/[0-9a-f]{32}\.usercontent\.test$/,
    );
    expect(reviewConfig(await viewerHtml(fallback, shared.url)).frameOrigin).toBeNull();
  });
});

describe("review frame script", () => {
  test("targets the viewer origin on a usercontent host and * in fallback mode", async () => {
    const usercontent = createEnv(true);
    const isolated = await publishHtml(usercontent);
    const frameOrigin = reviewConfig(await viewerHtml(usercontent, isolated.url)).frameOrigin;

    const isolatedFrame = await fetchWorker(
      usercontent,
      new Request(`${frameOrigin}/frame/${isolated.id}/${tokenOf(isolated.url)}/v/1`),
    );

    expect(await isolatedFrame.text()).toContain(frameScriptTag(ORIGIN));

    const fallback = createEnv(false);
    const shared = await publishHtml(fallback);

    const sharedFrame = await fetchWorker(
      fallback,
      new Request(`${ORIGIN}/frame/${shared.id}/${tokenOf(shared.url)}/v/1`),
    );

    expect(sharedFrame.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(await sharedFrame.text()).toContain(frameScriptTag("*"));
  });

  test("is valid JavaScript that cannot close its own script element", () => {
    for (const origin of ["*", ORIGIN]) {
      const tag = frameScriptTag(origin);
      const body = tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</script>"));

      expect(body).not.toContain("</script");
      expect(() => new Function(body)).not.toThrow();
    }
  });
});

describe("embedded response formatter", () => {
  test("ships the shared formatter's source in the viewer page", async () => {
    const env = createEnv(true);
    const published = await publishHtml(env);

    expect(await viewerHtml(env, published.url)).toContain(formatReviewMarkdown.toString());
  });

  test("produces the same copy response as the shared function", () => {
    const embedded = new Function(
      `${embeddedFormatterSource()}\nreturn formatReviewMarkdown;`,
    )() as typeof formatReviewMarkdown;

    expect(embedded(fixture)).toBe(formatReviewMarkdown(fixture));
  });

  test("viewer script parses and cannot close its own script element", () => {
    const script = reviewViewerScript();

    expect(script).not.toContain("</script");
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("serial decision saver", () => {
  test("keeps one save in flight and sends the latest answer last", async () => {
    let answer = "dark";
    let stored = "";
    const sent: string[] = [];
    const releases: (() => void)[] = [];
    let idle = 0;

    const saver = createSerialSaver(
      () => {
        const value = answer;

        sent.push(value);

        return new Promise<void>((resolve) => {
          releases.push(() => {
            stored = value;
            resolve();
          });
        });
      },
      () => {
        idle += 1;
      },
    );

    saver.request();
    answer = "light";
    saver.request();
    answer = "auto";
    saver.request();

    expect(sent).toEqual(["dark"]);
    expect(saver.busy()).toBe(true);

    releases[0]!();
    await Bun.sleep(0);

    expect(sent).toEqual(["dark", "auto"]);

    releases[1]!();
    await Bun.sleep(0);

    expect(stored).toBe("auto");
    expect(saver.busy()).toBe(false);
    expect(idle).toBe(1);
  });

  test("runs a queued save after a failed one", async () => {
    const calls: number[] = [];
    let release: () => void = () => {};

    const saver = createSerialSaver(
      () => {
        calls.push(calls.length);

        return calls.length === 1
          ? new Promise<void>((_, reject) => {
              release = () => reject(new Error("offline"));
            })
          : Promise.resolve();
      },
      () => {},
    );

    saver.request();
    saver.request();
    release();
    await Bun.sleep(0);

    expect(calls).toEqual([0, 1]);
    expect(saver.busy()).toBe(false);
  });

  test("ships in the viewer script", () => {
    expect(reviewViewerScript()).toContain(
      embeddedFunction("createSerialSaver", createSerialSaver),
    );
  });
});

describe("initial review load merge", () => {
  test("keeps comments saved while the load was pending and adds the rest", () => {
    const local = [
      { id: "saved-during-load", body: "new" },
      { id: "local-pending", body: "pending" },
    ];

    const loaded = [
      { id: "older", body: "from server" },
      { id: "saved-during-load", body: "stale copy" },
    ];

    expect(mergeLoaded(local, loaded)).toEqual([
      { id: "older", body: "from server" },
      { id: "saved-during-load", body: "new" },
      { id: "local-pending", body: "pending" },
    ]);
  });

  test("takes the server copy when nothing changed locally", () => {
    expect(mergeLoaded([], [{ id: "a" }, { id: "b" }])).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("ships in the viewer script", () => {
    expect(reviewViewerScript()).toContain(embeddedFunction("mergeLoaded", mergeLoaded));
  });
});
