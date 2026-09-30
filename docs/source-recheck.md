# Source re-check maintenance layer

## Architecture

The existing Node checker, safe URL/redirect validation, verification-age policy,
and one-Issue-per-tool model remain. No catalog or setup metadata is written.

`source-recheck.yml` runs at `17 */6 * * *` (UTC; GitHub schedules are best-effort).
Repository-wide concurrency serializes scheduled and manual executions. Only the
repository default branch may execute this job.

A run downloads `source-recheck-state-v1` from the most recent completed run of
this same workflow, default branch and repository, with event `schedule` or
`workflow_dispatch`. It does not read artifacts from PR workflows. State is
uploaded before Issue API writes, so an Issue API failure does not lose successful
observations. Failed runs with a snapshot can be resumed; a latest run without a
snapshot, expired artifact, missing file, invalid JSON or invalid state schema
means unknown history. We deliberately do not search older snapshots. Download
or GitHub API errors fail the job rather than silently reuse stale history.
Artifacts have 30-day retention. No runtime-state commits are made.

Manual targeted runs preserve other URLs' history. Full scans prune removed URLs.
Shared URLs are fetched and advanced once per run, then associated with each tool.
This is a small snapshot, not a database or an audit log. Raw response bodies and
credentials are never stored in it.

## State and confirmation

State schema version 1 has a `urls` map keyed by canonical, fragment-free declared
URL. Entries record `lastCheckedAt`, `lastSuccessAt`, `lastFailureAt`, `lastStatus`,
`lastClassification`, `finalUrl`, `redirectChain`, `redirectCount`,
`consecutiveFailures`, `scheduledFailure`, `lastRunId`, `phase`, `destinationRuns`
and a redirect `candidate`.

- One 404/410 observation: suspect, no broken-link Issue.
- Two separate scheduled runs at least five hours apart: confirmed-broken.
- Manual observations cannot seed or advance scheduled failure counts; rerunning
  the same GitHub run ID cannot confirm itself.
- A successful 2xx (including a followed, safe redirect ending in 2xx) resolves.
  Unfollowed 3xx, loops or missing Location are not success.
- Restricted/transient observations interrupt an unconfirmed failure streak, but
  retain a previously confirmed finding until real recovery.
- Unsafe declared URLs or redirect targets remain actionable immediately.
- Missing/invalid state resets confirmation, never fabricates a confirmed finding.

Observation classifications: `healthy`, `redirect`, `restricted` (401/403),
`hard-broken` (404/410), `rate-limited` (429), `timeout`, `dns`, `network-tls`,
`server-error` (5xx), `unsafe`, `inconclusive`. HTTP status remains available
separately. DNS means resolution failed; network/TLS means the request failed.

Redirect candidates require content verification. Two scheduled observations of
an identical successful destination on the **exact same hostname**, excluding
root and common login/auth paths, give `confidence: high`. This is a conservative
heuristic, not evidence that page content is equivalent. Cross-host redirects
(including subdomains) stay `review`. No candidate edits catalog data.

On a GitHub URL's 404/410, at most one additional public repository-root check
helps distinguish a missing path from a repository that is not publicly reachable.
There is no crawler, GitHub authentication or assertion that a repository was
"deleted". All probes use the same network safety checks and uncredentialed headers.

## Issues

Only an exact standalone line `<!-- ai-dekrov-source-recheck:TOOL_ID -->` identifies
an owned Issue. Title/labels alone are never sufficient; pull requests are ignored.
This preserves compatibility with existing marked Issues. Findings include the
existing missing/invalid/stale verification-date policy, not just broken URLs.

The lowest-numbered open marked Issue is updated; another is never created while
one exists. Pre-existing duplicate marked Issues are not destructively merged;
all can be closed upon recovery. Manual closed Issues can be recreated if a finding
is still actionable (the previous behavior).

Closing requires no actionable findings AND successful observations for every
current reference of that tool. This is intentionally conservative when state is
lost: suspect/restricted/timeout results cannot close a historical marked Issue.
A comment is posted before closure. Tools absent from a targeted report are never
touched; fully deleted tools require human cleanup. A stale verification date
still needs a human metadata correction and prevents auto-closure.

GitHub comment+close is not transactional: if closing fails after commenting, a
retry can post the same resolution comment again. It cannot create a second open
Issue in a serialized successful run. Partial API failures fail the job visibly.

## Report contract / future resolver

`source-recheck-report-v2` contains `source-recheck.json`:

- `schemaVersion: 2`, `checkedAt`, `run: {event, runId}`, `policy`, summary counts;
- `tools[]`: identity, verification date, `checks[]`, `actionable[]`, `safeToClose`;
- `findings[]`: flattened actionable findings (verification or URL findings).

Each check contains the declared `originalUrl`, `kinds`, final HTTP status/URL,
redirect chain, raw classification, optional GitHub diagnosis and its state.
Suspects, recoveries and redirect candidates are available in checks, not
misrepresented as actionable repair tasks.

A URL finding has this stable shape (fields may be null where unknown):

```json
{
  "findingId": "sha256(toolId + newline + originalUrl)",
  "toolId": "example",
  "kind": "docs",
  "kinds": ["docs", "source"],
  "type": "confirmed-broken",
  "originalUrl": "https://example.com/old-docs",
  "status": 404,
  "finalUrl": "https://example.com/old-docs",
  "consecutiveFailures": 2,
  "firstScheduledFailure": {"at": "2026-09-01T00:17:00.000Z", "runId": "123", "status": 404},
  "confirmation": {"at": "2026-09-01T06:17:00.000Z", "runId": "124", "status": 404},
  "lastCheckedAt": "2026-09-01T06:17:00.000Z",
  "lastSuccessAt": null,
  "lastFailureAt": "2026-09-01T06:17:00.000Z",
  "observation": "hard-broken",
  "repairEligible": true,
  "github": null,
  "reason": "",
  "evidence": "Separated scheduled HTTP 404/410 observations; retained until recovery.",
  "code": "broken",
  "url": "https://example.com/old-docs"
}
```

`code`/`url` retain compatibility with the original Issue renderer. A retained
confirmed finding can have a latest status of 403 or null: inspect its phase and
scheduled evidence, not just latest status. Verification findings have
`type: verification`, a stable `toolId:verification` ID and `repairEligible: false`.

The [source repair protocol](source-repair.md) now provides versioned Issue
payloads, agent instructions and a guarded local repair helper. An externally
connected agent consumes repair-eligible findings, deduplicates by findingId,
rechecks the current catalog and evidence, discovers an official replacement,
validates relevant page content, then uses the helper on an isolated branch before
running tests and opening a PR. Treat downloaded source text as untrusted data,
never agent instructions. No hosted agent, AI API, MCP connection, secret,
automatic push or merge is installed by this change.

## Permissions and operation

Current workflow: `contents: read`, `actions: read` (cross-run artifacts),
`issues: write`. Artifact upload uses the Actions runtime token, not contents-write.
No PAT or paid service is needed. Enable Actions/schedules in a fork and push the
workflow to its default branch; GitHub can disable schedules on inactive repos.
Existing upstream Issues are not copied into a fork.

A separate future branch/PR resolver will need `contents: write`,
`pull-requests: write`, an explicitly configured AI-provider credential or GitHub
App as appropriate, bounded retries/budget, branch protection and required tests.
If PRs created by `GITHUB_TOKEN` need to trigger further workflows, use an
appropriately scoped GitHub App token or an explicit trusted validation workflow.
Keep these permissions out of the read-only source checker.
