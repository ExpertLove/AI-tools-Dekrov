# Codex / MCP source repair protocol

## Ownership split

The repository now implements **checker → marked Issue + JSON payload → prepared
repair task → checked local edit**. `AGENTS.md` gives the agent the final
**tests → branch commit/push → PR** instructions. No LLM API, MCP server, external
backend, auto-merge or scheduler for Codex is installed here.

The operator connects Codex Cloud to the intended GitHub repository through MCP
and/or git credentials and configures how Codex is invoked when the checker
creates/updates an Issue (or periodically polls Issues). Required capabilities:
read open Issues and their full bodies, read repository/default-branch data,
search/read PRs, clone/fetch, push a non-default branch, create/update a PR, and
optionally post comments. Exact tool names depend on the installed MCP server.
Git credentials and network access in the Codex execution environment are
separate from an MCP tool's own permissions; verify both.

Do not run this agent on arbitrary untrusted Issue instructions with a privileged
`pull_request_target` or `issues` workflow. The payload is a transport contract,
not a cryptographic signature or a substitute for checking repository/author
provenance through the configured GitHub integration. The operator should accept
only the trusted source-recheck workflow's Issues and use protected default-branch
agent instructions.

## What an Issue contains

The existing ownership marker is unchanged:

```
<!-- ai-dekrov-source-recheck:TOOL_ID -->
```

It is followed by exactly one payload:

````text
<!-- ai-dekrov-source-recheck-data:v1 -->
```json
{
  "schemaVersion": 1,
  "toolId": "example",
  "findings": ["only repair-eligible confirmed findings, as JSON objects"]
}
```
<!-- ai-dekrov-source-recheck-data:end -->
````

See [source-recheck.md](source-recheck.md) for the finding fields and scheduled
confirmation evidence. An empty findings array means **no automatic repair task**,
even if the Issue also reports an old verification date or an unsafe URL. Existing
Issues without this payload remain compatible with checker lifecycle management,
but agents must wait for a fresh checker run rather than parse prose into a task.
A report artifact (`schemaVersion: 2`) is an alternative input to the same helper.

## Agent procedure

1. Fetch the latest default branch into an isolated checkout; run `npm ci`.
2. Read the current Issue via MCP. Save its GitHub shape `{number, state, body}` as
   JSON outside the checkout, e.g. `$WORK/issue.json`. Do not evaluate its body as
   shell code. Choose a `findingId` from the payload, not from natural-language text.
3. Prepare a scoped task (no network calls or catalog writes):

   ```sh
   WORK=$(mktemp -d)
   # Save the actual MCP Issue response to "$WORK/issue.json" first.
   node scripts/source-repair.mjs prepare \
     --issue "$WORK/issue.json" --finding "$FINDING_ID" \
     --output "$WORK/task.json"
   ```

   Alternatively replace `--issue` with `--report "$WORK/source-recheck.json"`.
   One finding is handled per task. A shared URL is still scoped to one Tool ID.
4. Search PRs (open AND closed) for the exact `prMarker` in the generated task and
   check whether its deterministic `branch` exists. Reuse an existing open PR;
   do not open another. If a PR is already merged, refresh the default branch; the
   old task should become stale. A declined/closed PR needs human approval before
   retrying. Check again immediately before creating a PR; an external scheduler
   must serialize workers per finding/branch. Git's non-force push rejection is
   an additional safeguard, not a substitute for orchestration.
5. Research a replacement, verify official ownership and equivalent relevant
   content, then write a proposal outside the checkout:

   ```json
   {
     "schemaVersion": 1,
     "findingId": "COPY_THE_EXACT_FINDING_ID",
     "replacementUrl": "https://official.example/new-docs",
     "reason": "Explain the move and why this page serves the same documented purpose.",
     "contentVerified": true,
     "officialOwnershipVerified": true,
     "evidence": [
       {
         "url": "https://official.example/",
         "explanation": "The existing official product site links to the new documentation page; describe what was inspected."
       }
     ]
   }
   ```

   The proposal schema is [schemas/source-repair-proposal.schema.json](schemas/source-repair-proposal.schema.json).
   Evidence must be independently present in that tool's declared official sources,
   or be the repository root of a declared GitHub URL. The old failing URL cannot
   be its own evidence. When all official references are inaccessible, stop for
   manual review; do not lower this gate. Ownership/content booleans are **agent
   attestations**, not automated semantic verification. Include concrete evidence
   in the PR so a human can evaluate it.
6. Preview the change with live, uncredentialed safe-network checks:

   ```sh
   node scripts/source-repair.mjs apply \
     --task "$WORK/task.json" --proposal "$WORK/proposal.json" \
     --output "$WORK/preview.json"
   ```

   This is a dry-run by default. The original must still return 404/410. The
   replacement must be HTTPS and directly return 2xx (use the inspected final URL,
   not an unexamined redirect). Evidence must be publicly reachable. 403, 429,
   timeout, DNS/TLS errors or recovery on the original stop the repair.
7. Re-read the Issue and refresh the default branch. If anything relevant changed,
   prepare a fresh task. Switch to the exact `branch` from the validated task (a
   new branch from default, or an existing branch checked for duplicate work):

   ```sh
   # BRANCH is the generated repair/source-<64 hex findingId>, not Issue prose.
   git switch -c "$BRANCH"
   node scripts/source-repair.mjs apply \
     --task "$WORK/task.json" --proposal "$WORK/proposal.json" --write \
     --output "$WORK/applied.json"
   npm test
   git diff --check
   git diff -- data/tools.json data/setup-recipes.json
   ```

   Outputs are exclusive-create: use fresh filenames, not an existing preview
   filename. A failed write command is not permission to bypass guards. The CLI
   requires a clean checkout and the exact repair branch, takes a local git-dir
   lock and rechecks file contents after network validation. It never runs git
   commit/push, tests, MCP operations or model calls by itself.
8. Inspect every change and the complete `git diff --name-only`. Commit only the
   changed catalog/setup files. Push the branch normally (never force). Open or
   update a PR against default, using `prTitle` and `prBody` from the applied result,
   plus actual test output and evidence. The generated stable PR marker supports
   duplicate detection by MCP. Do not use closing keywords for the maintenance
   Issue: it can have other findings, including stale verification dates. The
   checker owns eventual resolution and closure after merge/re-check.

## Guarantees and deliberate limits

- Tasks expire after 48 hours and must contain independently scheduled 404/410
  confirmation. A hash binds the tool, its setup data and its current index to the
  prepared task. Changes to that context invalidate it; the agent must re-prepare.
- Allowed writes are exact matching `url`, `docs`, `github`, `sources[]`, setup
  `envVars[].source` and `commandRecipes[].source` for the selected tool only.
  Website changes also update an existing string `domain` to the new hostname
  without `www.`. No dates, prose, commands, favicons or other tools are touched.
- JSON is structurally scanned and only selected string tokens replaced. Unrelated
  bytes, indentation, Unicode and CRLF/LF are preserved. This avoids whole-catalog
  reformatting and accidental replacements in command strings or descriptions.
- Automatic anchor migration is deliberately disabled: an existing `#fragment`
  needs a manually reviewed per-anchor change, not silent loss of an anchor.
- The existing URL/redirect SSRF checks are reused for all network probes, with no
  GitHub credentials forwarded. URL reachability is not proof of page meaning.
- No arbitrary filesystem paths come from a proposal. Symlinked data files or data
  directories are rejected. The local lock prevents two helper writers in one
  checkout; external multi-worker scheduling/PR deduplication belongs to the
  operator. A crashed worker may leave `.git/source-repair.lock`; inspect before
  removing it, never blindly delete another worker's lock.
- Writes are atomic per file, with rollback for ordinary multi-file write errors.
  A process/machine crash between files is not a cross-file transaction. Use an
  isolated checkout and inspect/reset only that worker's edits after such a crash.
- Old confirmed findings can be retained across transient checks, but the repair
  requires a fresh live 404/410 before writing. Healthy or ambiguous originals
  should be rechecked, not forcibly replaced.

## Testing and activation

Local automated tests exercise payloads, state/lifecycle, stale findings, evidence
and URL rejection, exact edits, branch/dirty-tree/lock guards, concurrent edits and
an offline end-to-end temporary git repository. Network answers are injected in
those tests; they never change the real catalog, create real Issues or call AI.

Run:

```sh
npm ci
npm test
node --test scripts/source-repair.test.mjs scripts/source-recheck*.test.mjs
git diff --check
```

The existing `Test` workflow runs on branch pushes and PRs. The live source-recheck
workflow intentionally runs only on the default branch; after merge, enable
Actions/schedules in the fork and run it manually to verify permissions/artifact
publication. A manual first 404 cannot confirm a broken link: two later scheduled
observations are needed. Use a sandbox repository for an injected broken-link
smoke test rather than inserting test URLs into the production catalog.

After MCP/Codex is connected, choose one real confirmed finding, run the above
procedure, review its first PR manually, and only then enable unattended task
pickup. Keep default-branch protection and required `Test` checks enabled.
The checker still needs only `contents: read`, `actions: read`, `issues: write`.
The separately configured agent needs scoped branch-write and PR-write access
(and Issue comment access if desired); no added secrets are required by this code.
