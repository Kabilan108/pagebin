---
name: pagebin-release-deploy
description: Deploy the PageBin Cloudflare Worker or publish a PageBin CLI release safely. Use when asked to deploy PageBin, cut a release, tag or publish a version, verify production after deployment, or determine whether Worker and CLI release state are aligned.
---

# PageBin release and deploy

Treat Worker deployment and CLI release as separate operations. Do only the operation the user requested and report explicitly what remains local, unpushed, untagged, or unpublished.

## Preflight

1. Inspect `git status`, the current branch, recent tags, and the remote release state.
2. Preserve unrelated user changes. Stop if the requested release cannot be isolated safely.
3. Run `bun test`, `bun run typecheck`, `bun run build`, and `git diff --check` in proportion to the change.
4. Run the requested review boundary and resolve true positives before publishing.
5. Never print, inspect, source verbosely, or include `.envrc` in tool output.

## Deploy the Worker

The repo's Nix shell provides tools; direnv loads the repo-scoped credentials. Deploy with:

```sh
direnv exec . bun run deploy
```

Capture the Cloudflare Worker version ID. Verify production with read-only checks:

- `https://page-bin.com/robots.txt` returns 200.
- A missing public route returns the branded HTML 404.
- A missing API route returns a plain-text 404.
- If the change affects the authenticated dashboard, verify it through Cloudflare Access without exposing capability URLs.

Do not treat a successful Worker upload as a CLI release.

## Publish a CLI release

1. Confirm the intended semantic version and that it does not already exist remotely.
2. Update `package.json`, the lockfile if needed, and `CHANGELOG.md` together.
3. Re-run the complete verification gates after version changes.
4. Commit the release, create the annotated tag, and push only when explicitly authorized.
5. Publish the GitHub release and its expected build artifacts/checksums using the repository's current release workflow.
6. Verify the remote tag, release, and downloadable artifact rather than inferring success from a local tag.

## Report

Return the commit, Worker version ID or CLI version, live checks performed, and whether the branch, tag, or release was pushed. Never include credentials, deployment-token values, publish tokens, or artifact capability URLs.
