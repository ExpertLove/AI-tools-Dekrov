# AI-Dekrov

**[Open the catalog →](https://ai.dekrov.com)**

AI-Dekrov is a public catalog of useful AI tools: services, coding agents, models, CLIs, desktop applications, and platforms worth knowing about.

Browse trusted links, supported platforms, pricing, install commands, and short factual descriptions without unnecessary noise.

## Explore the catalog

- Search by name, description, tag, category, platform, or model.
- Filter by price, platform, and tool execution (Local, Cloud, or Hybrid), or show tools with a supported no-signup / no-API-key path.
- Save favorites and your theme preference in your own browser.
- Open a dedicated page for every tool, with its official links and commands.

## Dev Resources catalog

AI-Dekrov has two catalogs. The **AI Tools** catalog lists AI products; the **Dev Resources** catalog lists useful websites and utilities for developers: ready UI components, CSS/JS snippets, generators, icon and SVG libraries, mock API tools, JSON utilities, and similar sites that provide a concrete, reusable solution to a development task.

Switch between the two with the **AI Tools | Dev Resources** switcher at the top of the catalog. Dev Resources keeps the same product experience: categories, search, filters (price, open source, no signup, copyable code), sorting, dedicated resource pages, favorites, My Stack, and collections.

Resources live in `data/dev-resources.json` and are added the same way tools are — one structured entry per resource, with no UI code changes needed. Each entry carries an id, name, category, description, official URL, tags, technologies, pricing, and flags such as open source / no signup / copyable code. The context-aware **Add a resource** dialog offers Smart Add, Manual, and JSON Import paths; each produces the same strict `dev-resource` payload and opens a separate moderated GitHub submission, never direct browser publication. `addedAt` is deliberately omitted from public submissions and assigned only by the approval workflow. Maintainers can also edit the data file directly; validation keeps malformed entries out automatically.

The catalog intentionally starts empty: entries are added manually over time and must meet the same quality bar as AI tools (real site, concrete resource, verifiable official URL).

## Suggest a tool

Click **Suggest a tool** on the website and choose the fastest option:

- **Smart Add** starts with an official tool URL. GitHub Actions analyzes the page (and a few official pages like pricing or docs), builds a schema-valid tool record, checks it, and prepares a moderated submission automatically.
- **Manual** is a full editor for entering the tool details yourself.
- **JSON Import** includes an AI Prompt Builder: use an external model to prepare schema-valid JSON, validate it here, then submit it for review.

Smart Add, Manual, and JSON Import all produce the same kind of submission. Submissions are checked for valid JSON, URLs, enums, IDs, and potential duplicates. A moderator reviews the result before it can become a pull request. Nothing is published automatically.

Tool records also carry three structured environment fields: `executionMode`, `signupRequirement`, and `apiKeyRequirement`. Execution describes where the tool product runs, not where model inference happens; a local tool may still call a remote model API. API-key requirement means a user-provided key—OAuth, account login, and subscriptions are not API keys. When official evidence is insufficient, the canonical value is `unknown`.

For a deeper local analysis, the repository owner can run `npm run add-tool -- <url>`, which downloads the page, shows a preview, and writes to `data/tools.json` only after confirmation.

You can also use the [GitHub submission form](https://github.com/DekrovDev/AI-tools-Dekrov/issues/new?template=tool-submission.yml).

## Principles

- Entries should describe real tools and use verifiable official sources.
- Unknown information stays empty rather than being invented.
- The public catalog lives in this repository and is the same for every visitor.
- Personal notes live only in the current browser and are never included in public data or submissions.

## AI provider configuration

Smart Add enrichment and the moderator `ai-enrich` flow call an OpenAI-compatible LLM provider. The provider is configured entirely through GitHub Actions variables and secrets — no code changes are needed:

| Setting | Where | Value |
| --- | --- | --- |
| `AI_PROVIDER_BASE_URL` | repository variable | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | repository variable | `nvidia/nemotron-3-super-120b-a12b:free` |
| `AI_API_KEY` | repository secret | your provider API key |

Configure them at **Settings → Secrets and variables → Actions** in the repository.

**Recommended: OpenRouter.** Free models (currently `nvidia/nemotron-3-super-120b-a12b:free`) cost nothing, which is fine for occasional enrichment. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys). Other OpenRouter models (e.g. `z-ai/glm-5.2:free` or `z-ai/glm-4.7-flash`) can be used by changing `AI_MODEL`; free-tier shared pools can be rate-limited, in which case enrichment is skipped silently.

**Alternative: Z.ai directly.** Use `https://api.z.ai/api/paas/v4` as `AI_PROVIDER_BASE_URL` and `glm-5.2` as `AI_MODEL`, with an API key from [z.ai](https://z.ai). New accounts get free starter credits, after which it is pay-as-you-go.

If any of these settings are missing, enrichment is skipped silently — the deterministic analysis and the normal validation flow still work without an AI provider.

## Project

AI-Dekrov is a static GitHub Pages project. Its public data and source code live in this repository.

### Setup recipe metadata

`data/setup-recipes.json` is a versioned, optional metadata file for the future `.env Builder` and `Command Builder`. It is separate from the Tool schema: environment variables and parameterized setup recipes describe setup paths, not a tool's catalog identity.

- Store only verified variable names, descriptions, requirement semantics, generic hints, and official source URLs. Real credentials never belong in the repository.
- Existing `install`, `start`, and `commands` values in `data/tools.json` remain the primary command sources. Add a parameterized recipe only when an official command cannot be represented by those fields.
- `assets/js/setup-recipes.js` parses the metadata and builds `.env` or command text entirely client-side. It does not fetch, persist, transmit, log, or execute entered values.
- Generated commands are copyable text for the visitor to review. AI-Dekrov never runs them and does not claim universal shell safety.

Malformed or unavailable setup metadata disables only the future builders; catalog data, search, tool details, Start Here, and Use Cases remain available. Any later UI must keep entered values in ephemeral memory only—never URLs, storage, analytics, logs, or GitHub submissions.

### Shareable Collections

Collections are browser-local by default and never leave your browser. A Collection can also be shared as a **snapshot encoded straight into a URL** (`#/shared/<token>`):

- **Share** on a collection copies a link containing only the collection name and its tool IDs. Local ids, timestamps, notes, favorites, My Stack, and filters are never included.
- **Opening a shared link does not save anything.** It renders a read-only view of the tools, scoped to the same search and filters as the rest of the site. Only pressing **Save to Collections** writes a new local collection.
- The payload is compact base64url JSON (UTF-8 safe for Cyrillic and emoji). Decoding is hardened: malformed, oversized, wrong-version, or unknown-tool links are rejected gracefully without breaking the catalog.
- Copied links are immutable snapshots. If the sender later renames a collection or adds/removes tools, an old link keeps its original contents.
- Codec and validation live in `assets/js/shared-collections.js` (DOM-free); no backend, API, database, or accounts are involved.

### Install / setup failure reports

Visitors can report a broken installation, start, command, or setup step for any catalog tool from **Setup → Commands → Report install issue**. Clicking it opens the repository's dedicated GitHub Issue Form (`install-failure.yml`) in a new tab with a structured title like `[Install failure][aider] Aider`. The site never sends anything to GitHub through an API: it only opens GitHub's hosted form.

- Reports are **public**, independent issues — they are **not** tool submissions. They never receive `tool-submission`/`approved`, never trigger approval PR, enrichment, or Smart Add workflows, and never modify `data/tools.json` or `data/setup-recipes.json`.
- A `validate-install-failure` workflow parses the structured form with the same `section`/`emptyResponse` helpers as tool submissions, resolves the tool ID from the title (or the optional Tool ID field), checks the required fields, and labels the issue `install-failure` (plus `needs-info` when more/consistent information is needed). It never creates a branch, PR, or deployment.
- The form warns upfront that reports are public and asks submitters to remove API keys, tokens, passwords, cookies, and other secrets before submitting.
- Parser/validator: `.github/scripts/install-failure-lib.mjs` · workflow: `.github/workflows/validate-install-failure.yml` · labels in `data/labels.json` · URL builder: `assets/js/install-failure.js`.

### Automatic official-source re-check

GitHub Actions re-checks repository-declared official references every six hours (00:17, 06:17, 12:17, 18:17 UTC) and can be run manually for one exact tool ID or the whole catalog. It checks `sources`, website, docs, GitHub, and setup-recipe source URLs with bounded requests, redirect safety checks, and private/local-network blocking; GitHub credentials are never sent to those external hosts.

Only 404/410 responses confirmed by separate scheduled runs at least five hours apart, and unsafe declared URLs, are link findings. A versioned Actions artifact preserves URL state between runs; missing or corrupted state restarts confirmation. Manual runs cannot accelerate confirmation. 401/403 are recorded as restricted, while timeouts, DNS/TLS/network failures, 429, and 5xx responses are inconclusive and do not create Issues by themselves. A missing, invalid, future, or more-than-90-day-old `lastVerifiedAt` is also a human-review finding.

Each affected tool gets a `[Source recheck][tool-id]` maintenance Issue, labeled `source-recheck` and `needs-review`, reusing an existing machine-marked open Issue instead of creating duplicates. Only exact machine markers establish ownership. When all findings resolve and current references are reachable, automation comments and closes its Issues; transient errors never count as recovery. These Issues are signals for maintainers: HTTP success means only that a reference was reachable from the runner. It never refreshes `lastVerifiedAt`, changes catalog/setup data, opens a PR, or changes a branch. A maintainer should inspect the official source and verify and submit factual corrections through the normal trusted path. Versioned machine-readable reports and redirect candidates prepare a future branch/tests/PR resolver without connecting an AI service. See [source re-check architecture and report contract](docs/source-recheck.md) for state, lifecycle, permissions and tradeoffs. For externally connected Codex/MCP agents, [the source repair protocol](docs/source-repair.md) and `AGENTS.md` explain machine-readable Issue payloads, the guarded `scripts/source-repair.mjs` helper, and the tests → branch → PR procedure. The helper does not connect an AI service, push, or merge automatically.

### Client-side search

The catalog builds one in-memory [Orama](https://docs.orama.com/docs/orama-js) index from `data/tools.json` after the page loads. Search, typo tolerance, relevance ranking, and structured filters run entirely in the browser. The production page resolves the pinned `@orama/orama` 3.1.18 ESM package through the import map in `index.html`; no build step, backend, hosted search service, API key, or Node server is required.

Search-specific parsing and index behavior live in `assets/js/search-engine.js`. Node tests resolve the same exact package version from `package.json` and `package-lock.json`.

Made by Dekrov — [dekrov.com](https://dekrov.com) · [GitHub](https://github.com/DekrovDev)
