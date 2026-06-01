import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeEndpoint, parseArgs, parseTtlSeconds } from "../src/cli";

interface CliRun {
  exitCode: number;
  stderr: string;
  stdout: string;
}

describe("parseTtlSeconds", () => {
  test("parses supported units", () => {
    expect(parseTtlSeconds("30s")).toBe(30);
    expect(parseTtlSeconds("5m")).toBe(300);
    expect(parseTtlSeconds("2h")).toBe(7200);
    expect(parseTtlSeconds("7d")).toBe(604800);
    expect(parseTtlSeconds("2w")).toBe(1209600);
  });

  test("rejects ambiguous values", () => {
    expect(() => parseTtlSeconds("30")).toThrow();
    expect(() => parseTtlSeconds("0d")).toThrow();
    expect(() => parseTtlSeconds("1mo")).toThrow();
    expect(() => parseTtlSeconds("999999w")).toThrow();
  });
});

describe("parseArgs", () => {
  test("parses publish defaults", () => {
    expect(parseArgs(["publish", "plan.html"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "publish",
      options: {
        endpoint: "https://example.com",
        filePath: "plan.html",
        json: false,
        sandbox: "standard",
        ttlSeconds: null,
      },
    });
  });

  test("parses publish options", () => {
    expect(
      parseArgs(["publish", "plan.html", "--ttl", "7d", "--sandbox", "strict", "--json"], {
        PAGEBIN_ENDPOINT: "https://example.com/",
      }),
    ).toEqual({
      command: "publish",
      options: {
        endpoint: "https://example.com",
        filePath: "plan.html",
        json: true,
        sandbox: "strict",
        ttlSeconds: 604800,
      },
    });
  });

  test("parses delete", () => {
    expect(parseArgs(["delete", "abc123", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "delete",
      options: {
        endpoint: "https://example.com",
        id: "abc123",
        json: true,
      },
    });
  });

  test("parses delete IDs that begin with a dash", () => {
    expect(parseArgs(["delete", "-abc123456789012", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "delete",
      options: {
        endpoint: "https://example.com",
        id: "-abc123456789012",
        json: true,
      },
    });
  });

  test("parses list", () => {
    expect(parseArgs(["list", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "list",
      options: {
        endpoint: "https://example.com",
        json: true,
      },
    });
  });

  test("parses reissue", () => {
    expect(parseArgs(["reissue", "abc123", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "reissue",
      options: {
        endpoint: "https://example.com",
        id: "abc123",
        json: true,
      },
    });
  });

  test("parses reissue IDs that begin with a dash", () => {
    expect(parseArgs(["reissue", "-abc123456789012", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "reissue",
      options: {
        endpoint: "https://example.com",
        id: "-abc123456789012",
        json: true,
      },
    });
  });
});

describe("normalizeEndpoint", () => {
  test("allows localhost http", () => {
    expect(normalizeEndpoint("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  test("requires https for non-local endpoints", () => {
    expect(() => normalizeEndpoint("http://example.com")).toThrow();
  });
});

describe("publish command", () => {
  test("prints only the URL by default and sends the expected multipart request", async () => {
    const filePath = await writeTempFile("cli-plan.html", "<!doctype html><h1>cli</h1>");
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/api/publish");
        expect(request.headers.get("Authorization")).toBe("Bearer publish-token");
        expect(Number(request.headers.get("Content-Length"))).toBeGreaterThan(0);

        const form = await request.formData();
        const file = form.get("file");

        expect(form.get("sandbox")).toBe("standard");
        expect(form.get("ttlSeconds")).toBeNull();
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("cli-plan.html");
        expect(await (file as File).text()).toBe("<!doctype html><h1>cli</h1>");

        return Response.json(
          {
            id: "artifact-id",
            url: "https://pagebin.test/p/artifact-id/view-token",
            expiresAt: null,
            sandbox: "standard",
          },
          { status: 201 },
        );
      },
    });

    try {
      const result = await runPagebin(["publish", filePath, "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("https://pagebin.test/p/artifact-id/view-token\n");
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("prints structured JSON and sends ttl/sandbox fields", async () => {
    const filePath = await writeTempFile("cli-plan.html", "<!doctype html><h1>cli</h1>");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(Number(request.headers.get("Content-Length"))).toBeGreaterThan(0);

        const form = await request.formData();

        expect(form.get("sandbox")).toBe("strict");
        expect(form.get("ttlSeconds")).toBe("604800");

        return Response.json(
          {
            id: "artifact-id",
            url: "https://pagebin.test/p/artifact-id/view-token",
            expiresAt: "2026-06-07T00:00:00.000Z",
            sandbox: "strict",
          },
          { status: 201 },
        );
      },
    });

    try {
      const result = await runPagebin(["publish", filePath, "--endpoint", server.url.origin, "--ttl", "7d", "--sandbox", "strict", "--json"], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        id: "artifact-id",
        url: "https://pagebin.test/p/artifact-id/view-token",
        expiresAt: "2026-06-07T00:00:00.000Z",
        sandbox: "strict",
      });
    } finally {
      server.stop(true);
    }
  });

  test("rejects non-html files before sending a request", async () => {
    const filePath = await writeTempFile("cli-plan.txt", "not html");
    const result = await runPagebin(["publish", filePath, "--endpoint", "http://localhost:8787"], {
      PAGEBIN_PUBLISH_TOKEN: "publish-token",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pagebin only accepts .html files.");
  });
});

describe("list command", () => {
  test("prints a table of stored pages", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        expect(request.method).toBe("GET");
        expect(new URL(request.url).pathname).toBe("/api/artifacts");
        expect(request.headers.get("Authorization")).toBe("Bearer publish-token");

        return Response.json({
          artifacts: [
            {
              id: "artifact-id",
              filename: "cli-plan.html",
              createdAt: "2026-06-01T12:00:00.000Z",
              expiresAt: null,
              sandbox: "standard",
              size: 1536,
            },
          ],
        });
      },
    });

    try {
      const result = await runPagebin(["list", "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("ID");
      expect(result.stdout).toContain("Filename");
      expect(result.stdout).toContain("artifact-id");
      expect(result.stdout).toContain("cli-plan.html");
      expect(result.stdout).toContain("1.5 KB");
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("prints structured JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          artifacts: [
            {
              id: "artifact-id",
              filename: "cli-plan.html",
              createdAt: "2026-06-01T12:00:00.000Z",
              expiresAt: null,
              sandbox: "standard",
              size: 1536,
            },
          ],
        });
      },
    });

    try {
      const result = await runPagebin(["list", "--endpoint", server.url.origin, "--json"], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        artifacts: [
          {
            id: "artifact-id",
            filename: "cli-plan.html",
            createdAt: "2026-06-01T12:00:00.000Z",
            expiresAt: null,
            sandbox: "standard",
            size: 1536,
          },
        ],
      });
    } finally {
      server.stop(true);
    }
  });

  test("prints a clear message when no pages are stored", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ artifacts: [] });
      },
    });

    try {
      const result = await runPagebin(["list", "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("No stored pages.\n");
    } finally {
      server.stop(true);
    }
  });

  test("prints expired pages until scheduled cleanup removes them", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          artifacts: [
            {
              id: "expired-artifact",
              filename: "old-plan.html",
              createdAt: "2026-05-01T12:00:00.000Z",
              expiresAt: "2026-05-02T12:00:00.000Z",
              sandbox: "standard",
              size: 512,
            },
          ],
        });
      },
    });

    try {
      const result = await runPagebin(["list", "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("expired-artifact");
      expect(result.stdout).toContain("2026-05-02T12:00:00Z");
      expect(result.stdout).not.toContain("\x1b[31m");
    } finally {
      server.stop(true);
    }
  });
});

describe("reissue command", () => {
  test("prints only the new URL by default", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/artifact-id/reissue");
        expect(request.headers.get("Authorization")).toBe("Bearer publish-token");

        return Response.json({
          id: "artifact-id",
          url: "https://pagebin.test/p/artifact-id/new-token",
          expiresAt: null,
          sandbox: "standard",
        });
      },
    });

    try {
      const result = await runPagebin(["reissue", "artifact-id", "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("https://pagebin.test/p/artifact-id/new-token\n");
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("reissues IDs that begin with a dash", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/-artifact-id-1234/reissue");

        return Response.json({
          id: "-artifact-id-1234",
          url: "https://pagebin.test/p/-artifact-id-1234/new-token",
          expiresAt: null,
          sandbox: "standard",
        });
      },
    });

    try {
      const result = await runPagebin(["reissue", "-artifact-id-1234", "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("https://pagebin.test/p/-artifact-id-1234/new-token\n");
    } finally {
      server.stop(true);
    }
  });

  test("prints structured JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "artifact-id",
          url: "https://pagebin.test/p/artifact-id/new-token",
          expiresAt: "2026-06-07T00:00:00.000Z",
          sandbox: "strict",
        });
      },
    });

    try {
      const result = await runPagebin(["reissue", "artifact-id", "--endpoint", server.url.origin, "--json"], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        id: "artifact-id",
        url: "https://pagebin.test/p/artifact-id/new-token",
        expiresAt: "2026-06-07T00:00:00.000Z",
        sandbox: "strict",
      });
    } finally {
      server.stop(true);
    }
  });
});

async function writeTempFile(filename: string, contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pagebin-test-"));
  const filePath = join(directory, filename);

  await writeFile(filePath, contents);

  return filePath;
}

async function runPagebin(args: string[], env: Record<string, string>): Promise<CliRun> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stderr,
    stdout,
  };
}
