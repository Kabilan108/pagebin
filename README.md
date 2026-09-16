# pagebin

`pagebin` publishes agent-generated documents, media, and downloadable files to a private Cloudflare R2 bucket. Each artifact is served at a long-lived, unlisted capability URL. A Cloudflare Access-protected dashboard catalogs artifacts by project and source host.

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
pagebin versions <artifact_id_or_viewer_url_or_file>
pagebin rollback <artifact_id_or_viewer_url_or_file> <version>
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

### Files and attachments

```bash
pagebin publish ./demo.webm --verify --json
pagebin publish ./screenshot.png --verify --json
pagebin publish ./trace.zip --json
pagebin publish ./report/index.html --assets ./report/pictures --verify --json
pagebin update ./report/index.html --json
```

Image viewers fit the original to the window. Video and audio viewers use native browser controls, with a download fallback for unsupported codecs. PageBin stores the original without transcoding. PDFs open in a self-hosted PDF.js reader on desktop and mobile, with page navigation, zoom, search, and text selection. The reader starts at page width; the original PDF is still available to download. PDF scripts are disabled. Other files have a download page. The dashboard opens on Documents; Media, Files, and All filters keep recordings and downloads separate from plans. An HTML bundle is one document entry with an attachment count.

`--assets DIR` explicitly includes every regular file in that directory, recursively, under its basename. Repeat the flag for more directories. There is no default asset directory or gallery template, and PageBin does not crawl HTML for files. For example, `--assets ./report/pictures` makes `pictures/variant.png` available to relative `<img>` and `<video>` references. Symlinks, duplicate paths, and traversal paths are rejected. File paths may contain spaces and Unicode; control characters, backslashes, percent signs, query markers, and fragment markers are rejected.

Receipts remember the asset directories for update, watch, and verify. Supply them again on another machine. An explicit list replaces the remembered list. Watch observes the entry file and included directories. Files removed from a selected directory disappear from the next version, while retained versions keep their files.

New file uploads return `url`, `rawUrl`, and `downloadUrl` in JSON. `url` opens the viewer; the other two pin the published version. Use `rawUrl` as an image or video source in HTML, and `downloadUrl` to force a download. PRs can link to the viewer or use a linked image preview; inline playback of an external video URL depends on the PR host. Embedding shares the capability URL with that host, which may cache a copy.

Each bundle version has a manifest of paths, types, sizes, and SHA-256 checksums. Unchanged files reuse objects within that artifact. Files upload individually before an atomic metadata commit; failed or conflicting uploads leave the previous version visible. `contentSha256` for these artifacts identifies the canonical manifest, and `files[].sha256` identifies each file's bytes. URL-based verification downloads and hashes every file; ID-based verification checks the stored manifest. Public manifest responses omit storage keys.

Limits are 50 MiB per file, 250 MiB per bundle, and 200 files including the entrypoint. Small standalone HTML/Markdown remains compatible with the existing document upload API; larger documents use streamed uploads. The Worker can lower the file limit with `PAGEBIN_MAX_FILE_BYTES`. Upload sessions expire after 30 minutes; abandoned objects are collected after the existing one-hour grace period. Larger resumable uploads are not implemented.

Active documents remain sandboxed, including direct SVG navigation. Every viewer, file, manifest, and download request checks the artifact capability and expiry; reissue revokes all previous routes. Unknown file formats download as `application/octet-stream` with `nosniff`.

### Version history

PageBin automatically retains the last 10 content versions of each artifact. Identical-content updates are deduplicated, while `pagebin versions` lists retained versions and `pagebin rollback` marks an older version as current again (publishing new content resumes from the highest version number). Pinned viewers use `/p/<id>/<token>/v/<n>` and never auto-reload. Reissuing an artifact rotates the capability token for the current content and all retained history; deletion or expiry removes every version.

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
- Artifact HTML stays in private R2 and renders through a sandboxed iframe with no-referrer, no-store, noindex, nosniff, and restrictive permissions headers. The standard sandbox delegates clipboard writes for user-initiated copy controls but keeps artifacts on an opaque origin without browser storage access.
- Markdown permits raw HTML without sanitization, matching direct HTML uploads. Treat published source as trusted; use the strict sandbox for static Markdown when scripts and other interactive permissions are unnecessary. Mermaid requires the standard sandbox.
- Metadata mutation uses R2 ETag preconditions, monotonic revisions, tombstones, and versioned content objects to prevent lost updates and token resurrection.
- Bundle cleanup retains every attachment referenced by every retained version. Do not downgrade to a Worker without manifest-aware cleanup after publishing bundles; an older Worker could delete their attachments.
- Unreferenced or pruned content is removed after a grace period; expired and deleted artifacts are tombstoned before content removal.

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

### PDF reader build

Wrangler builds the reader assets before local development and deployment with `bun run scripts/build-pdf-viewer.ts`. This downloads the pinned official PDF.js legacy distribution, verifies its SHA-256, and disables PDF scripting and saved preference overrides. The generated files live in `dist/worker-assets` and are served by the Worker's `ASSETS` binding. No PDF content or capability URL is sent to a third-party viewer. Builds require access to GitHub releases; checksum or configuration patch mismatches fail the build.
