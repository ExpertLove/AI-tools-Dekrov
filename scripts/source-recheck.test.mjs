import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { looksLikeInstallFailure } from "../.github/scripts/install-failure-lib.mjs";
import { looksLikeSmartAdd, looksLikeSubmission } from "../.github/scripts/submission-lib.mjs";
import {
  CHECK_CONCURRENCY, MAX_REDIRECTS, NEEDS_REVIEW_LABEL, REQUEST_TIMEOUT_MS,
  SOURCE_RECHECK_LABEL, STALE_AFTER_DAYS, actionableFindingsForTool,
  canonicalCheckUrl, classifyAttemptPair, classifyHttpStatus,
  collectToolCheckTargets, isBlockedHostname, isPrivateAddress,
  planSourceRecheckIssues, sourceRecheckIssueBody, sourceRecheckIssueTitle,
  verificationAgeDays, verificationFinding
} from "../.github/scripts/source-recheck-lib.mjs";
import {
  SOURCE_RECHECK_HEADERS, buildSourceRecheckReport, checkDeclaredUrl,
  loadSetupRecipes, validatePublicRequestUrl
} from "../.github/scripts/recheck-official-sources.mjs";
import { applySourceRecheckIssues } from "../.github/scripts/apply-source-recheck-issues.mjs";
import { parseSetupRecipes } from "../assets/js/setup-recipes.js";

const catalog = JSON.parse(readFileSync(new URL("../data/tools.json", import.meta.url), "utf8"));
const setupSource = JSON.parse(readFileSync(new URL("../data/setup-recipes.json", import.meta.url), "utf8"));
const setup = parseSetupRecipes(setupSource, new Set(catalog.map((tool) => tool.id)));
const now = new Date("2026-08-31T12:00:00.000Z");

function response(status, location = "") {
  return { status, headers: { get: (name) => name.toLowerCase() === "location" ? location : "" }, body: { cancel: async () => {} } };
}
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

test("collects declared source scope in stable order and merges duplicate kinds", () => {
  const targets = collectToolCheckTargets({ id: "demo", name: "Demo", sources: ["https://example.com/reference#part", "https://example.com/reference"], url: "https://example.com/", docs: "https://example.com/docs", github: "https://github.com/example/demo" }, { envVars: [{ source: "https://example.com/docs" }, { source: 42 }], commandRecipes: [{ source: "https://example.com/recipe" }] });
  assert.deepEqual(targets.map((target) => [target.url, target.kinds]), [
    ["https://example.com/reference", ["source"]],
    ["https://example.com/", ["website"]],
    ["https://example.com/docs", ["docs", "setup-source"]],
    ["https://github.com/example/demo", ["github"]],
    ["https://example.com/recipe", ["setup-source"]]
  ]);
});

test("real catalog check targets are structurally valid HTTP(S), including setup sources", () => {
  const allTargets = catalog.flatMap((tool) => collectToolCheckTargets(tool, setup.tools[tool.id] || {}));
  assert.ok(allTargets.length > catalog.length);
  assert.ok(allTargets.every((target) => /^https?:\/\//.test(target.url)));
  assert.ok(allTargets.some((target) => target.kinds.includes("setup-source")));
  assert.ok(allTargets.every((target) => canonicalCheckUrl(target.url)));
});

test("verification staleness is UTC-based and actionable only when older than 90 days", () => {
  assert.equal(STALE_AFTER_DAYS, 90);
  assert.equal(verificationAgeDays("2026-06-03", now), 89);
  assert.equal(verificationAgeDays("2026-06-02", now), 90);
  assert.equal(verificationFinding("2026-06-02", now), null);
  assert.equal(verificationFinding("2026-06-01", now).code, "stale");
  assert.equal(verificationFinding("", now).code, "missing");
  assert.equal(verificationFinding("2026-02-31", now).code, "invalid");
  assert.equal(verificationFinding("2026-09-01", now).code, "invalid");
});

test("HTTP classes keep restricted and transient results non-actionable, and require two hard failures", () => {
  for (const status of [200, 204]) assert.equal(classifyHttpStatus(status), "healthy");
  for (const status of [401, 403]) assert.equal(classifyHttpStatus(status), "restricted");
  for (const status of [301, 399, 408, 416, 425]) assert.equal(classifyHttpStatus(status), "inconclusive");
  assert.equal(classifyAttemptPair({ classification: "hard-broken" }, { classification: "hard-broken" }), "broken");
  assert.equal(classifyAttemptPair({ classification: "hard-broken" }, { classification: "healthy" }), "inconclusive");
  assert.equal(classifyAttemptPair({ classification: "hard-broken" }, { classification: "inconclusive" }), "inconclusive");
  assert.equal(classifyAttemptPair({ classification: "hard-broken" }, { classification: "unsafe" }), "unsafe");
  const findings = actionableFindingsForTool({ lastVerifiedAt: "2026-08-30", checks: [{ classification: "restricted" }, { classification: "inconclusive" }, { classification: "broken", kinds: ["docs"], originalUrl: "https://example.com", finalStatus: 404 }] }, now);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "broken");
});

test("network safety blocks local names, direct IPs, and private DNS answers", async () => {
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("localhost.."), true);
  assert.equal(isBlockedHostname("api.internal"), true);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("0:0:0:0:0:0:0:1"), true);
  assert.equal(isPrivateAddress("fc00::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal((await validatePublicRequestUrl("http://localhost:3000/", { lookupImpl: publicDns })).classification, "unsafe");
  assert.equal((await validatePublicRequestUrl("http://127.0.0.1/", { lookupImpl: publicDns })).classification, "unsafe");
  assert.equal((await validatePublicRequestUrl("http://[::1]/", { lookupImpl: publicDns })).classification, "unsafe");
  assert.equal((await validatePublicRequestUrl("https://example.com/", { lookupImpl: async () => [{ address: "169.254.1.1", family: 4 }] })).classification, "unsafe");
  assert.equal((await validatePublicRequestUrl("https://example.com/", { lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] })).classification, "unsafe");
  assert.equal((await validatePublicRequestUrl("https://example.com/", { lookupImpl: publicDns })).ok, true);
});

test("declared URL checking uses private headers, safe redirects, and exactly one observation", async () => {
  const requests = [];
  const sequence = [response(301, "/next"), response(200)];
  const healthy = await checkDeclaredUrl({ url: "https://example.com/start", kinds: ["docs"] }, { lookupImpl: publicDns, fetchImpl: async (url, options) => { requests.push({ url, options }); return sequence.shift(); } });
  assert.equal(healthy.classification, "redirect");
  assert.equal(healthy.finalUrl, "https://example.com/next");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.headers.Cookie, undefined);
  assert.equal(requests[0].options.headers["User-Agent"], "AI-Dekrov-Source-Recheck/1.0");
  assert.equal(requests[0].options.headers.Range, "bytes=0-4095");
  const broken = await checkDeclaredUrl({ url: "https://example.com/missing", kinds: ["source"] }, { lookupImpl: publicDns, fetchImpl: async () => response(404) });
  assert.equal(broken.classification, "hard-broken");
  const gone = await checkDeclaredUrl({ url: "https://example.com/gone", kinds: ["source"] }, { lookupImpl: publicDns, fetchImpl: async () => response(410) });
  assert.equal(gone.classification, "hard-broken");
  const mixed = [response(404), response(410)];
  assert.equal((await checkDeclaredUrl({ url: "https://example.com/mixed", kinds: ["source"] }, { lookupImpl: publicDns, fetchImpl: async () => mixed.shift() })).classification, "hard-broken");
  const recoveredResponses = [response(404), response(200)];
  const recovered = await checkDeclaredUrl({ url: "https://example.com/flaky", kinds: ["source"] }, { lookupImpl: publicDns, fetchImpl: async () => recoveredResponses.shift() });
  assert.equal(recovered.classification, "hard-broken");
  assert.deepEqual(recovered.attempts.map((attempt) => attempt.status), [404]);
  const timedOut = [response(404), new Error("timeout")];
  assert.equal((await checkDeclaredUrl({ url: "https://example.com/timeout", kinds: ["source"] }, { lookupImpl: publicDns, fetchImpl: async () => { const value = timedOut.shift(); if (value instanceof Error) throw value; return value; } })).classification, "hard-broken");
});

test("redirect loops, missing locations, and unsafe redirect targets stay inconclusive or unsafe", async () => {
  const loop = await checkDeclaredUrl({ url: "https://example.com/loop" }, { lookupImpl: publicDns, maxRedirects: 1, fetchImpl: async () => response(302, "/loop") });
  assert.equal(loop.classification, "inconclusive");
  const missing = await checkDeclaredUrl({ url: "https://example.com/missing-location" }, { lookupImpl: publicDns, fetchImpl: async () => response(302) });
  assert.equal(missing.classification, "inconclusive");
  const unsafe = await checkDeclaredUrl({ url: "https://example.com/to-local" }, { lookupImpl: publicDns, fetchImpl: async () => response(302, "http://localhost/secret") });
  assert.equal(unsafe.classification, "unsafe");
  const absolute = [response(301, "https://docs.example.com/guide"), response(200)];
  assert.equal((await checkDeclaredUrl({ url: "https://example.com/docs" }, { lookupImpl: publicDns, fetchImpl: async () => absolute.shift() })).classification, "redirect");
  const privateRedirect = await checkDeclaredUrl({ url: "https://example.com/private" }, { lookupImpl: async (host) => host === "private.example" ? [{ address: "10.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }], fetchImpl: async () => response(302, "https://private.example/") });
  assert.equal(privateRedirect.classification, "unsafe");
  assert.ok(MAX_REDIRECTS <= 5);
  assert.equal(REQUEST_TIMEOUT_MS, 12_000);
  assert.equal(CHECK_CONCURRENCY, 5);
});

test("report builder filters exact tool IDs, preserves deterministic output, and never changes verification data", async () => {
  const tools = [
    { id: "zulu", name: "Zulu", url: "https://z.example", lastVerifiedAt: "2026-05-01" },
    { id: "alpha", name: "Alpha", url: "https://a.example", lastVerifiedAt: "2026-08-30" }
  ];
  const report = await buildSourceRecheckReport({ tools, now, check: async (target) => ({ ...target, originalUrl: target.url, finalUrl: target.url, finalStatus: 200, redirects: 0, attempts: [], classification: "healthy", reason: "" }) });
  assert.deepEqual(report.tools.map((tool) => tool.id), ["alpha", "zulu"]);
  assert.equal(report.tools[1].lastVerifiedAt, "2026-05-01");
  assert.equal(report.tools[1].actionable[0].code, "stale");
  const one = await buildSourceRecheckReport({ tools, toolId: "alpha", now, check: async (target) => ({ ...target, classification: "healthy" }) });
  assert.equal(one.toolsChecked, 1);
  await assert.rejects(() => buildSourceRecheckReport({ tools, toolId: "Alpha", now }), /Unknown tool_id/);
});

test("missing setup metadata is optional but malformed checked-in setup metadata fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-dekrov-source-recheck-"));
  try {
    assert.deepEqual(await loadSetupRecipes(path.join(directory, "missing.json"), new Set()), { version: 1, tools: {} });
    const malformed = path.join(directory, "malformed.json");
    await writeFile(malformed, "{ nope");
    await assert.rejects(() => loadSetupRecipes(malformed, new Set()), /setup-recipes.json is invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("maintenance Issue bodies are deterministic, grouped, escaped, and never claim automatic correction", () => {
  const tool = {
    id: "aider",
    name: "Aider <script>",
    lastVerifiedAt: "2026-05-01",
    actionable: [
      { type: "verification", code: "stale", message: "Verification is 122 days old." },
      { type: "url", code: "broken", kinds: ["docs", "setup-source"], url: "https://example.com/`bad`", status: 404 }
    ]
  };
  const body = sourceRecheckIssueBody(tool, "2026-08-31T12:00:00.000Z");
  assert.equal(sourceRecheckIssueTitle(tool), "[Source recheck][aider] Aider \\<script\\>");
  assert.ok(body.includes("<!-- ai-dekrov-source-recheck:aider -->"));
  assert.ok(body.includes("HTTP reachability is not factual verification."));
  assert.equal(body.includes("automatic correction"), false);
  assert.equal(body.includes("response body"), false);
});

test("Issue planning deduplicates only matching open maintenance Issues and preserves labels", () => {
  const report = { checkedAt: "2026-08-31T12:00:00.000Z", tools: [{ id: "aider", name: "Aider", lastVerifiedAt: "", actionable: [{ type: "verification", code: "missing", message: "Verification date is missing." }] }] };
  const create = planSourceRecheckIssues(report, []);
  assert.deepEqual(create[0].labels, [SOURCE_RECHECK_LABEL, NEEDS_REVIEW_LABEL]);
  const unchanged = planSourceRecheckIssues(report, [{ number: 7, state: "open", title: create[0].title, body: create[0].body, labels: [SOURCE_RECHECK_LABEL, NEEDS_REVIEW_LABEL, "maintainer-note"] }]);
  assert.equal(unchanged[0].action, "unchanged");
  const laterRun = planSourceRecheckIssues({ ...report, checkedAt: "2026-09-01T12:00:00.000Z" }, [{ number: 7, state: "open", title: create[0].title, body: create[0].body, labels: [SOURCE_RECHECK_LABEL, NEEDS_REVIEW_LABEL] }]);
  assert.equal(laterRun[0].action, "unchanged");
  const changedReport = { ...report, tools: [{ ...report.tools[0], actionable: [...report.tools[0].actionable, { type: "url", code: "broken", kinds: ["docs"], url: "https://example.com/docs", status: 404 }] }] };
  const update = planSourceRecheckIssues(changedReport, [{ number: 7, state: "open", title: create[0].title, body: create[0].body, labels: [] }]);
  assert.equal(update[0].action, "update");
  assert.deepEqual(update[0].addLabels, [SOURCE_RECHECK_LABEL, NEEDS_REVIEW_LABEL]);
  const closed = planSourceRecheckIssues(report, [{ number: 7, state: "closed", title: create[0].title, body: create[0].body }]);
  assert.equal(closed[0].action, "create");
  const unrelated = planSourceRecheckIssues(report, [{ number: 8, state: "open", title: "Please source recheck aider", body: "unrelated" }]);
  assert.equal(unrelated[0].action, "create");
});

test("GitHub Issue API failures surface and never belong to external-source request headers", async () => {
  await assert.rejects(() => applySourceRecheckIssues({ tools: [] }, { repo: "owner/repo", token: "secret", fetchImpl: async () => response(500) }), /GitHub API GET/);
  for (const forbidden of ["Authorization", "Cookie", "GITHUB_TOKEN", "Bearer"]) assert.equal(Object.keys(SOURCE_RECHECK_HEADERS).some((key) => key.toLowerCase().includes(forbidden.toLowerCase())), false);
});

test("source recheck workflow is scheduled, dispatchable, least-privilege, and isolated from existing Issue automations", () => {
  const workflow = readFileSync(new URL("../.github/workflows/source-recheck.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes('cron: "17 */6 * * *"'));
  assert.ok(workflow.includes("workflow_dispatch"));
  assert.ok(workflow.includes("tool_id"));
  assert.ok(workflow.includes('--tool "$TOOL_ID"'));
  assert.ok(workflow.includes("contents: read"));
  assert.ok(workflow.includes("actions: read"));
  assert.ok(workflow.includes("cancel-in-progress: false"));
  assert.ok(workflow.includes("github.ref_name == github.event.repository.default_branch"));
  assert.ok(workflow.includes("workflow_id: 'source-recheck.yml'"));
  assert.ok(workflow.includes("source-recheck-state-v1"));
  assert.ok(workflow.includes("source-recheck-report-v2"));
  assert.ok(workflow.includes("issues: write"));
  for (const forbidden of ["contents: write", "pull-requests: write", "git push", "gh pr create", "apply-submission", "enrich-submission", "tool-submission", "install-failure", "needs-info", "ai-enrich"]) assert.equal(workflow.includes(forbidden), false, forbidden);
  assert.ok(workflow.includes("ensure-labels.mjs"));
  assert.ok(workflow.includes(SOURCE_RECHECK_LABEL));
  assert.ok(workflow.includes(NEEDS_REVIEW_LABEL));
  const title = "[Source recheck][aider] Aider";
  const body = "## AI-Dekrov automatic source re-check\n\nNo conflicting form sections.";
  assert.equal(looksLikeSubmission(body), false);
  assert.equal(looksLikeSmartAdd(title, body), false);
  assert.equal(looksLikeInstallFailure(title, body), false);
});
