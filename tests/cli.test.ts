import { describe, expect, test } from "bun:test";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

  test("parses update with an artifact ID", () => {
    expect(parseArgs(["update", "abc1234567890123", "plan.html", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "update",
      options: {
        endpoint: "https://example.com",
        filePath: "plan.html",
        id: "abc1234567890123",
        json: true,
        url: null,
      },
    });
  });

  test("parses update with a viewer URL and infers the endpoint", () => {
    expect(parseArgs(["update", "https://pagebin.test/p/abc1234567890123/view-token", "plan.html"], {})).toEqual({
      command: "update",
      options: {
        endpoint: "https://pagebin.test",
        filePath: "plan.html",
        id: "abc1234567890123",
        json: false,
        url: "https://pagebin.test/p/abc1234567890123/view-token",
      },
    });
  });

  test("parses watch with a viewer URL", () => {
    expect(parseArgs(["watch", "https://pagebin.test/p/abc1234567890123/view-token", "plan.html"], {})).toEqual({
      command: "watch",
      options: {
        endpoint: "https://pagebin.test",
        filePath: "plan.html",
        id: "abc1234567890123",
        json: false,
        mode: "update",
        url: "https://pagebin.test/p/abc1234567890123/view-token",
      },
    });
  });

  test("parses watch with a file path as publish-then-watch", () => {
    expect(parseArgs(["watch", "plan.md"], { PAGEBIN_ENDPOINT: "https://example.com" })).toEqual({
      command: "watch",
      options: {
        endpoint: "https://example.com",
        filePath: "plan.md",
        json: false,
        mode: "publish",
        sandbox: "standard",
        ttlSeconds: null,
      },
    });
  });

  test("parses watch publish options", () => {
    expect(
      parseArgs(["watch", "plan.html", "--ttl", "7d", "--sandbox", "strict"], {
        PAGEBIN_ENDPOINT: "https://example.com",
      }),
    ).toEqual({
      command: "watch",
      options: {
        endpoint: "https://example.com",
        filePath: "plan.html",
        json: false,
        mode: "publish",
        sandbox: "strict",
        ttlSeconds: 604800,
      },
    });
  });

  test("parses watch for markdown extension variants", () => {
    expect(parseArgs(["watch", "plan.html"], { PAGEBIN_ENDPOINT: "https://example.com" }).options).toMatchObject({
      filePath: "plan.html",
      mode: "publish",
    });
    expect(parseArgs(["watch", "plan.markdown"], { PAGEBIN_ENDPOINT: "https://example.com" }).options).toMatchObject({
      filePath: "plan.markdown",
      mode: "publish",
    });
  });

  test("rejects update-only options on watch with an artifact target", () => {
    expect(() => parseArgs(["watch", "abc1234567890123", "plan.html", "--ttl", "7d"], { PAGEBIN_ENDPOINT: "https://example.com" })).toThrow(
      "--ttl can only be used with pagebin watch <file>.",
    );
    expect(() => parseArgs(["watch", "abc1234567890123", "plan.html", "--sandbox", "strict"], { PAGEBIN_ENDPOINT: "https://example.com" })).toThrow(
      "--sandbox can only be used with pagebin watch <file>.",
    );
  });

  test("rejects json for watch", () => {
    expect(() => parseArgs(["watch", "plan.html", "--json"], { PAGEBIN_ENDPOINT: "https://example.com" })).toThrow(
      "watch does not support --json because it is a long-running command.",
    );
  });

  test("reports watch errors for missing file path after artifact target", () => {
    expect(() => parseArgs(["watch", "abc1234567890123"], { PAGEBIN_ENDPOINT: "https://example.com" })).toThrow(
      "watch with an artifact target also requires a .html, .md, or .markdown file path.",
    );
  });

  test("parses subcommand help without endpoint configuration", () => {
    const commands = ["publish", "list", "reissue", "update", "watch", "delete", "version"] as const;

    for (const command of commands) {
      expect(parseArgs([command, "--help"], {})).toEqual({ command: "help", options: { topic: command } });
      expect(parseArgs([command, "-h"], {})).toEqual({ command: "help", options: { topic: command } });
      expect(parseArgs(["help", command], {})).toEqual({ command: "help", options: { topic: command } });
    }
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

describe("help command", () => {
  test("prints subcommand help without endpoint configuration", async () => {
    const commands = ["publish", "list", "reissue", "update", "watch", "delete", "version"];

    for (const command of commands) {
      const result = await runPagebin([command, "--help"], {});

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`pagebin ${command}`);
    }
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

  test("renders markdown files to HTML before publishing", async () => {
    const filePath = await writeTempFile(
      "cli-plan.md",
      `---
title: CLI Markdown
tags:
  - one
  - two
---

# CLI Markdown

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`,
    );
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        expect(request.method).toBe("POST");

        const form = await request.formData();
        const file = form.get("file");

        expect(form.get("filename")).toBe("cli-plan.md");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("cli-plan.html");

        const html = await (file as File).text();

        expect(html).toContain('<script type="application/json" id="markdown-source"');
        expect(html).toContain("CLI Markdown");
        expect(html).toContain("data-mermaid-viewport");
        expect(html).toContain("data-copy-code");
        expect(html).toContain("Properties");
        expect(html).toContain("Outline");

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

  test("rejects publishing markdown with the strict sandbox before sending a request", async () => {
    const filePath = await writeTempFile("cli-plan.md", "# CLI Markdown\n");
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    try {
      const result = await runPagebin(["publish", filePath, "--endpoint", server.url.origin, "--sandbox", "strict"], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Markdown rendering requires --sandbox standard");
      expect(requestCount).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("rejects oversized markdown before sending a request", async () => {
    const filePath = await writeTempFile("huge-report.md", "x".repeat(10 * 1024 * 1024 + 1));
    const result = await runPagebin(["publish", filePath, "--endpoint", "http://localhost:8787"], {
      PAGEBIN_PUBLISH_TOKEN: "publish-token",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File is larger than the 10 MB upload limit.");
  });

  test("rejects unsupported file types before sending a request", async () => {
    const filePath = await writeTempFile("cli-plan.txt", "not html");
    const result = await runPagebin(["publish", filePath, "--endpoint", "http://localhost:8787"], {
      PAGEBIN_PUBLISH_TOKEN: "publish-token",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pagebin only accepts .html, .md, or .markdown files.");
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

describe("update command", () => {
  test("updates content and prints the target URL when a URL was provided", async () => {
    const filePath = await writeTempFile("cli-plan.html", "<!doctype html><h1>updated</h1>");
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        expect(request.method).toBe("PUT");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/artifact-id-1234/content");
        expect(request.headers.get("Authorization")).toBe("Bearer publish-token");

        const form = await request.formData();
        const file = form.get("file");

        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("cli-plan.html");
        expect(await (file as File).text()).toBe("<!doctype html><h1>updated</h1>");

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-plan.html",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: null,
          sandbox: "standard",
          size: 31,
        });
      },
    });
    const url = `${server.url.origin}/p/artifact-id-1234/view-token`;

    try {
      const result = await runPagebin(["update", url, filePath], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${url}\n`);
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("updates content by ID and prints structured JSON", async () => {
    const filePath = await writeTempFile("cli-plan.html", "<!doctype html><h1>updated</h1>");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(request.method).toBe("PUT");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/artifact-id-1234/content");

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-plan.html",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: null,
          sandbox: "standard",
          size: 31,
        });
      },
    });

    try {
      const result = await runPagebin(["update", "artifact-id-1234", filePath, "--endpoint", server.url.origin, "--json"], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        id: "artifact-id-1234",
        filename: "cli-plan.html",
        updatedAt: "2026-06-18T00:00:00.000Z",
        expiresAt: null,
        sandbox: "standard",
        size: 31,
        url: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test("renders markdown files to HTML before updating", async () => {
    const filePath = await writeTempFile("cli-update.markdown", "# Updated\n\n```ts\nconst ok = true;\n```\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("PUT");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/artifact-id-1234/content");

        const form = await request.formData();
        const file = form.get("file");

        expect(form.get("filename")).toBe("cli-update.markdown");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("cli-update.html");

        const html = await (file as File).text();

        expect(html).toContain("Updated");
        expect(html).toContain("data-copy-code");

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-update.markdown",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: null,
          sandbox: "standard",
          size: html.length,
        });
      },
    });

    try {
      const result = await runPagebin(["update", "artifact-id-1234", filePath, "--endpoint", server.url.origin, "--json"], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });
      const payload = JSON.parse(result.stdout) as { filename: string; url: string | null };

      expect(result.exitCode).toBe(0);
      expect(payload.filename).toBe("cli-update.markdown");
      expect(payload.url).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("warns when updating a strict-sandbox artifact with markdown", async () => {
    const filePath = await writeTempFile("cli-update.md", "# Updated\n");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("PUT");

        const form = await request.formData();
        const file = form.get("file");

        expect(form.get("filename")).toBe("cli-update.md");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("cli-update.html");

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-update.md",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: null,
          sandbox: "strict",
          size: 120,
        });
      },
    });

    try {
      const result = await runPagebin(["update", "artifact-id-1234", filePath, "--endpoint", server.url.origin], {
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("artifact-id-1234\n");
      expect(result.stderr).toContain("strict-sandbox artifact");
    } finally {
      server.stop(true);
    }
  });
});

describe("watch command", () => {
  test("publishes markdown before watching a file path", async () => {
    const filePath = await writeTempFile("cli-watch.md", "# First\n");
    const uploads: string[] = [];
    let resolveUpdateUpload: (() => void) | null = null;
    const updateUpload = new Promise<void>((resolve) => {
      resolveUpdateUpload = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const form = await request.formData();
        const file = form.get("file");

        expect(file).toBeInstanceOf(File);

        const html = await (file as File).text();
        uploads.push(html);

        if (request.method === "POST") {
          const origin = new URL(request.url).origin;

          expect(new URL(request.url).pathname).toBe("/api/publish");
          expect(form.get("sandbox")).toBe("standard");
          expect(form.get("ttlSeconds")).toBeNull();
          expect(form.get("filename")).toBe("cli-watch.md");
          expect((file as File).name).toBe("cli-watch.html");
          expect(html).toContain("First");
          expect(html).toContain('<script type="application/json" id="markdown-source"');

          return Response.json(
            {
              id: "artifact-id-1234",
              url: `${origin}/p/artifact-id-1234/view-token`,
              expiresAt: null,
              sandbox: "standard",
            },
            { status: 201 },
          );
        }

        expect(request.method).toBe("PUT");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/artifact-id-1234/content");
        expect(form.get("filename")).toBe("cli-watch.md");
        expect((file as File).name).toBe("cli-watch.html");
        expect(html).toContain("Second");
        resolveUpdateUpload?.();

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-watch.md",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: null,
          sandbox: "standard",
          size: html.length,
        });
      },
    });
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "watch", filePath, "--endpoint", server.url.origin], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    let stdout = "";
    let stderr = "";

    try {
      await waitFor(() => uploads.length === 1);

      const nextPath = join(dirname(filePath), "cli-watch-next.md");
      await writeFile(nextPath, "# Second\n");
      await rename(nextPath, filePath);
      await withTimeout(updateUpload, 3000);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      server.stop(true);
      stdout = await new Response(proc.stdout).text();
      stderr = await new Response(proc.stderr).text();
    }

    expect(stdout.split("\n")[0]).toBe(`${server.url.origin}/p/artifact-id-1234/view-token`);
    expect(stderr).toContain(`Watching ${filePath}; press Ctrl-C to stop.`);
    expect(uploads).toHaveLength(2);
  });

  test("publishes html before watching a file path", async () => {
    const filePath = await writeTempFile("cli-watch.html", "<!doctype html><h1>first</h1>");
    const uploads: string[] = [];
    let resolveUpdateUpload: (() => void) | null = null;
    const updateUpload = new Promise<void>((resolve) => {
      resolveUpdateUpload = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const form = await request.formData();
        const file = form.get("file");

        expect(file).toBeInstanceOf(File);

        const html = await (file as File).text();
        uploads.push(html);

        if (request.method === "POST") {
          const origin = new URL(request.url).origin;

          expect(new URL(request.url).pathname).toBe("/api/publish");
          expect(form.get("sandbox")).toBe("strict");
          expect(form.get("ttlSeconds")).toBe("604800");
          expect(form.get("filename")).toBe("cli-watch.html");
          expect((file as File).name).toBe("cli-watch.html");
          expect(html).toBe("<!doctype html><h1>first</h1>");

          return Response.json(
            {
              id: "artifact-id-1234",
              url: `${origin}/p/artifact-id-1234/view-token`,
              expiresAt: "2026-06-25T00:00:00.000Z",
              sandbox: "strict",
            },
            { status: 201 },
          );
        }

        expect(request.method).toBe("PUT");
        expect(new URL(request.url).pathname).toBe("/api/artifacts/artifact-id-1234/content");
        expect(form.get("filename")).toBe("cli-watch.html");
        expect((file as File).name).toBe("cli-watch.html");
        expect(html).toBe("<!doctype html><h1>second</h1>");
        resolveUpdateUpload?.();

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-watch.html",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: "2026-06-25T00:00:00.000Z",
          sandbox: "strict",
          size: html.length,
        });
      },
    });
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "watch", filePath, "--endpoint", server.url.origin, "--ttl", "7d", "--sandbox", "strict"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    let stdout = "";

    try {
      await waitFor(() => uploads.length === 1);

      const nextPath = join(dirname(filePath), "cli-watch-next.html");
      await writeFile(nextPath, "<!doctype html><h1>second</h1>");
      await rename(nextPath, filePath);
      await withTimeout(updateUpload, 3000);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      server.stop(true);
      stdout = await new Response(proc.stdout).text();
      await new Response(proc.stderr).text();
    }

    expect(stdout.split("\n")[0]).toBe(`${server.url.origin}/p/artifact-id-1234/view-token`);
    expect(uploads).toEqual(["<!doctype html><h1>first</h1>", "<!doctype html><h1>second</h1>"]);
  });

  test("continues updating after atomic file replacement", async () => {
    const filePath = await writeTempFile("cli-plan.html", "<!doctype html><h1>first</h1>");
    const uploads: string[] = [];
    let resolveSecondUpload: (() => void) | null = null;
    const secondUpload = new Promise<void>((resolve) => {
      resolveSecondUpload = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("PUT");

        const form = await request.formData();
        const file = form.get("file");

        expect(file).toBeInstanceOf(File);
        uploads.push(await (file as File).text());

        if (uploads.length === 2) {
          resolveSecondUpload?.();
        }

        return Response.json({
          id: "artifact-id-1234",
          filename: "cli-plan.html",
          updatedAt: "2026-06-18T00:00:00.000Z",
          expiresAt: null,
          sandbox: "standard",
          size: 31,
        });
      },
    });
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "watch", "artifact-id-1234", filePath, "--endpoint", server.url.origin], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PAGEBIN_PUBLISH_TOKEN: "publish-token",
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      await waitFor(() => uploads.length === 1);

      const nextPath = join(dirname(filePath), "cli-plan-next.html");
      await writeFile(nextPath, "<!doctype html><h1>second</h1>");
      await rename(nextPath, filePath);
      await withTimeout(secondUpload, 3000);

      expect(uploads).toEqual(["<!doctype html><h1>first</h1>", "<!doctype html><h1>second</h1>"]);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      server.stop(true);
      await new Response(proc.stdout).text();
      await new Response(proc.stderr).text();
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

async function waitFor(predicate: () => boolean): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!predicate()) {
          return;
        }

        clearInterval(interval);
        resolve();
      }, 10);
    }),
    3000,
  );
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${milliseconds}ms.`));
    }, milliseconds);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
