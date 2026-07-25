# Worker guidance

- `revision` is not a content version: it bumps on TTL updates, reissues, tombstones, and pointer rollbacks, and the viewer's auto-reload poll keys off it. Content history lives in `versions[]` plus the `currentVersion` pointer.
- Rollback is a pointer move: it retargets `currentVersion` (idempotent, no new entry) and bumps `revision` so open viewers reload. New uploads append `maxVersion + 1` and take the pointer, so history intentionally does not record that a rollback happened.
- Content dedupe must compare `metadata.contentSha256`, never just the `versions[]` head entry: an out-of-band writer (e.g. an older Worker during a deploy window) can move the head without maintaining `versions[]`, and head-only comparison silently drops a real update (HTTP 200 with the wrong sha).
- `normalizeMetadata` reconciliation must only synthesize a head entry when NO `versions[]` entry references the current content; healing on "last entry != head" fabricates a version after every pointer rollback.
- `cleanupOrphanedContent` keeps every key referenced by `versions[]`, not just `contentKey`. Downgrading the Worker below 0.12.0 for over an hour permanently GCs retained history and breaks pinned `/v/<n>` URLs.
- Version-pinned routes use a path segment (`/p|/raw/<id>/<token>/v/<n>`), not `?v=` — the viewer already uses `?v=` as a cache-buster. One capability token covers all versions; reissue must revoke history routes too.
