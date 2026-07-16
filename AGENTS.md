# PageBin repository guidance

- Run production deploys with `direnv exec . bun run deploy`; `nix develop` provides tools but does not load the repo's `.envrc`. Never print or inspect `.envrc` in tool output. This deploys the Worker only; publishing a CLI release is a separate workflow.
- Launch local Worker QA with `wrangler.dev.toml`, not the production config: `bunx wrangler dev --config wrangler.dev.toml --port 8790 --var PAGEBIN_PUBLISH_TOKEN:test-publish-token --var PAGEBIN_PUBLIC_ORIGIN:http://127.0.0.1:8790`. Production custom-domain routing can otherwise turn localhost requests into misleading 421 responses.
- CLI tests use `Bun.serve({ port: 0 })`; restricted sandboxes can report `EADDRINUSE` for every server test when local socket binding is denied. Retry with localhost binding permission before diagnosing a port conflict.
- Keep the Markdown renderer dynamically imported from the CLI so non-Markdown startup stays fast. Use the renderer's parsed `hasMermaid` result as the sandbox/runtime source of truth; fence regexes diverge on nested and documented code blocks.
- Dashboard and authenticated-list metadata reads share a six-worker pool per R2 list page. Malformed metadata is skipped, while R2 `get()` and body-read failures must propagate so transient storage failures are not silently hidden.
