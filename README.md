# pagebin

`pagebin` publishes generated `.html` and Markdown artifacts to a private Cloudflare R2 bucket and serves them through a Cloudflare Worker using protected, unlisted URLs.

## CLI

```bash
export PAGEBIN_ENDPOINT="https://pagebin.<workers-subdomain>.workers.dev"
export PAGEBIN_PUBLISH_TOKEN="..."

pagebin publish ./plan.html
pagebin publish ./plan.md
pagebin publish ./plan.html --ttl 7d
pagebin publish ./plan.html --sandbox strict
pagebin publish ./plan.html --json
pagebin list
pagebin reissue <artifact_id>
pagebin update <artifact_id_or_viewer_url> ./plan.md
pagebin watch ./plan.md
pagebin watch ./plan.html
pagebin watch <artifact_id_or_viewer_url> ./plan.md
pagebin delete <artifact_id>
pagebin watch --help
```

Default publish and reissue output is only the protected URL, so it can be piped into a clipboard alias. Markdown files are rendered to a minimal dark HTML document before upload, including YAML frontmatter properties, GitHub-flavored Markdown tables and task lists, syntax highlighted code blocks with line numbers, and Mermaid diagrams with pan/zoom controls. Markdown rendering requires the default `--sandbox standard` mode because the generated page uses scripts for rendering and interaction. `pagebin update` replaces an existing artifact's content while preserving its current viewer URLs. If you pass a full viewer URL to `update`, the CLI prints that URL again; if you pass only an artifact ID, it prints the ID because view tokens are not stored. `pagebin watch <file>` publishes a new artifact, prints its viewer URL, then keeps re-uploading the file when it changes. `pagebin watch <artifact_id_or_viewer_url> <file>` performs an initial update of an existing artifact, then keeps re-uploading the file when it changes.

Open viewer pages poll for artifact changes and reload their iframe when the HTML is updated, so `pagebin watch <viewer_url> ./plan.html` gives a live preview loop without opening a new URL.

`pagebin list` shows stored page metadata, but not viewer URLs because view tokens are not stored. `pagebin reissue` generates a new viewer URL for an existing page and revokes the old URL. Every subcommand supports `-h` and `--help`.

## Nix

`pagebin` exposes a source-building flake package for `x86_64-linux`:

```bash
nix run github:Kabilan108/pagebin -- version
nix build github:Kabilan108/pagebin
```

In another flake:

```nix
inputs.pagebin = {
  url = "github:Kabilan108/pagebin";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Then install:

```nix
inputs.pagebin.packages.${system}.default
```

## Security Model

- The CLI authenticates to the Worker with `PAGEBIN_PUBLISH_TOKEN`.
- The CLI never receives Cloudflare or R2 credentials.
- The Worker stores HTML in a private R2 bucket.
- Each artifact gets a random ID and random view token.
- R2 metadata stores only a SHA-256 hash of the view token.
- Viewing requires `/p/<id>/<token>`.
- Raw HTML is served only through `/raw/<id>/<token>`.
- Updating an artifact preserves existing view tokens.
- Responses use `X-Robots-Tag: noindex, nofollow, noarchive`.
- Uploaded HTML is rendered in a sandboxed iframe by default.

## Worker Environment

Required secret:

```bash
wrangler secret put PAGEBIN_PUBLISH_TOKEN
```

Required R2 bucket:

```bash
wrangler r2 bucket create pagebin-artifacts
```

Expired artifacts are removed by the Worker cron trigger configured in `wrangler.toml`. The scheduled cleanup runs weekly and deletes both metadata and HTML objects for pages whose `expiresAt` timestamp has passed.

Optional Worker var:

```toml
[vars]
PAGEBIN_MAX_BYTES = "10485760"
```
