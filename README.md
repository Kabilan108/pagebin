# pagebin

`pagebin` publishes agent-generated HTML and Markdown artifacts to a private Cloudflare R2 bucket. Each artifact is served at a long-lived, unlisted capability URL. A Cloudflare Access-protected dashboard catalogs artifacts by project and source host.

## Origins

- `https://page-bin.com` serves public, unlisted `/p/<id>/<token>` viewers and `/raw/<id>/<token>` content.
- `https://api.page-bin.com` exposes publisher-token-authenticated CLI APIs.
- `https://admin.page-bin.com` serves the Cloudflare Access-protected dashboard and dashboard APIs.

The Worker rejects management requests on the public origin and artifact requests on the API origin. R2 remains private.

## CLI

```bash
export PAGEBIN_ENDPOINT="https://api.page-bin.com"
export PAGEBIN_PUBLISH_TOKEN="..."

pagebin publish ./plan.html --verify --json
pagebin publish ./report.md --type report
pagebin publish ./scratch.html --ttl 7d
pagebin update ./plan.html --json
pagebin update <artifact_id_or_viewer_url> ./plan.html
pagebin update <artifact_id_or_viewer_url> --ttl never
pagebin update <artifact_id_or_viewer_url> ./plan.html --ttl 7d
pagebin verify <artifact_id_or_viewer_url> ./plan.html --json
pagebin watch ./implementation-log.html --json
pagebin list
pagebin receipts
pagebin show <artifact_id_or_file>
pagebin reissue <artifact_id>
pagebin delete <artifact_id>
pagebin skill
```

Artifacts do not expire unless `--ttl` is provided. Markdown is rendered to static HTML in the CLI before upload, including GFM tables, highlighted code, frontmatter properties, and document outlines. Only documents containing Mermaid diagrams load the pinned Mermaid browser runtime.

`pagebin skill` prints concise, version-matched instructions for agents and does not require endpoint credentials.

### Metadata inference

Publish and update infer:

- title from frontmatter, `<title>`, or the first top-level heading;
- project and repository from the Git root and origin;
- source host, repository-relative path, branch, and commit;
- artifact type from the filename/path;
- agent from Codex, Claude Code, or OpenCode environment hints.

Override with `--title`, `--project`, `--repo`, `--source-host`, `--source-path`, `--git-branch`, `--git-commit`, `--type`, or `--agent`. `--agent` is the only authoritative agent override; there is no environment-variable override. Use `--no-infer` to send only explicit fields.

### Local receipts

Successful publication writes a mode-`0600` receipt under `${XDG_STATE_HOME:-~/.local/state}/pagebin/artifacts.json`. It stores the viewer URL, file association, hashes, revision, and provenance. This enables `pagebin update <file>` and URL recovery without storing plaintext viewer tokens in ordinary server listings.

Publishing the same endpoint/file pair again is rejected. Use update, or pass `--force-new` when a second artifact is intentional. Override the state location with `PAGEBIN_STATE_PATH`.

### Verification and machine output

`publish --verify` fetches `/raw/` and compares SHA-256 hashes. `verify` uses raw bytes when given a viewer URL and stored verification metadata when given an ID.

JSON output includes `schemaVersion: 1`. `watch --json` emits one compact JSON object per line for publish, update, and error events. Diagnostics remain on stderr.

## Dashboard

The dashboard supports:

- recent artifacts grouped by project;
- title, filename, project, and host search;
- project and host filters;
- expiration, revision, and provenance display;
- Open and Copy link through encrypted capability recovery;
- reissue and delete actions.

Legacy artifacts remain viewable but cannot be opened from the dashboard until reissued. Reissue revokes the previous URL.

## Security model

- Public URLs are unlisted bearer capabilities, not identity-based access control.
- Viewer tokens use 256 bits of randomness. Only their SHA-256 hashes are used for public request authentication.
- A second AES-256-GCM encrypted token copy enables single-artifact dashboard recovery. The key is a Worker secret and is never stored in R2.
- Dashboard endpoints validate the Cloudflare Access JWT signature, issuer, audience, and expiry. The CLI publisher token is never exposed to browser JavaScript.
- Artifact HTML stays in private R2 and renders through a sandboxed iframe with no-referrer, no-store, noindex, nosniff, and restrictive permissions headers.
- Markdown permits raw HTML without sanitization, matching direct HTML uploads. Treat published source as trusted; use the strict sandbox for static Markdown when scripts and other interactive permissions are unnecessary. Mermaid requires the standard sandbox.
- Metadata mutation uses R2 ETag preconditions, monotonic revisions, tombstones, and versioned content objects to prevent lost updates and token resurrection.
- Superseded/orphan content is removed after a grace period; expired and deleted artifacts are tombstoned before content removal.

Anyone with an artifact URL can view it. Do not publish credentials, cookies, tokens, or secret-bearing logs.

## Cloudflare deployment

Create the R2 bucket and required secrets:

```bash
wrangler r2 bucket create pagebin-artifacts
wrangler secret put PAGEBIN_PUBLISH_TOKEN
wrangler secret put PAGEBIN_CAPABILITY_KEY
```

`PAGEBIN_CAPABILITY_KEY` must be a base64url-encoded 32-byte key. Back it up separately. Losing it does not invalidate public links, but dashboard recovery will require reissuing them.

Configure these non-secret variables in the Worker environment:

```text
PAGEBIN_PUBLIC_ORIGIN=https://page-bin.com
PAGEBIN_CAPABILITY_KEY_VERSION=v1
PAGEBIN_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
PAGEBIN_ACCESS_AUD=<Access application AUD tag>
```

Create a Cloudflare Access self-hosted application for `admin.page-bin.com` with a deny-by-default policy that allows only the intended identity/group. Do not create an Access bypass rule. The Worker independently validates `Cf-Access-Jwt-Assertion` or the `CF_Authorization` cookie.

The custom domains are declared in `wrangler.toml`; `workers.dev` and preview URLs are disabled. Deploy with:

```bash
direnv exec . bun run deploy
```

After deployment, smoke-test publish with `--verify`, dashboard authentication, link recovery, reissue revocation, host isolation, and deletion.

## Nix

```bash
nix run github:Kabilan108/pagebin -- version
nix build github:Kabilan108/pagebin
```

The flake exposes the CLI package for `x86_64-linux`.
