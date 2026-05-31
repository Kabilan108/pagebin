# pagebin

`pagebin` publishes generated `.html` artifacts to a private Cloudflare R2 bucket and serves them through a Cloudflare Worker using protected, unlisted URLs.

## CLI

```bash
export PAGEBIN_ENDPOINT="https://pagebin.<workers-subdomain>.workers.dev"
export PAGEBIN_PUBLISH_TOKEN="..."

pagebin publish ./plan.html
pagebin publish ./plan.html --ttl 7d
pagebin publish ./plan.html --sandbox strict
pagebin publish ./plan.html --json
pagebin delete <artifact_id>
```

Default output is only the protected URL, so it can be piped into a clipboard alias.

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

Optional Worker var:

```toml
[vars]
PAGEBIN_MAX_BYTES = "10485760"
```
