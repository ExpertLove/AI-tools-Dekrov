import test from "node:test";
import assert from "node:assert/strict";
import { advanceUrl, parseState, emptyState } from "../.github/scripts/source-recheck-state.mjs";
import { buildSourceRecheckReport, checkDeclaredUrl } from "../.github/scripts/recheck-official-sources.mjs";
import { planSourceRecheckIssues, classifyHttpStatus } from "../.github/scripts/source-recheck-lib.mjs";
import { applySourceRecheckIssues } from "../.github/scripts/apply-source-recheck-issues.mjs";

const url = "https://example.com/docs";
const observation = (classification, status = 404, finalUrl = url) => ({ originalUrl: url, finalUrl, finalStatus: status, classification, redirects: classification === "redirect" ? 1 : 0 });
const context = (hour, event = "schedule", runId = String(hour)) => ({ now: new Date(`2026-09-01T${String(hour).padStart(2, "0")}:00:00Z`), event, runId });
const step = (prev, classification, hour, event, status) => advanceUrl(prev, observation(classification, status), context(hour, event));

test("first 404 suspects; independent scheduled observation confirms after time", () => {
  const first = step(null, "hard-broken", 0);
  assert.equal(first.phase, "suspect");
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(step(first, "hard-broken", 1).phase, "suspect");
  assert.equal(advanceUrl(first, observation("hard-broken"), context(6, "schedule", "0")).phase, "suspect");
  const second = step(first, "hard-broken", 6);
  assert.equal(second.phase, "confirmed-broken");
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(step(first, "healthy", 6, "schedule", 200).resolved, true);
  const recovery = step(second, "healthy", 12, "schedule", 200);
  assert.equal(recovery.phase, "healthy");
  assert.equal(recovery.consecutiveFailures, 0);
  assert.equal(recovery.scheduledFailure, null);
});

test("manual runs cannot seed or advance scheduled confirmation", () => {
  const manual = step(null, "hard-broken", 0, "workflow_dispatch");
  assert.equal(manual.scheduledFailure, null);
  const scheduled = step(manual, "hard-broken", 6);
  assert.equal(scheduled.phase, "suspect");
  const manualAgain = step(scheduled, "hard-broken", 12, "workflow_dispatch");
  assert.equal(manualAgain.phase, "suspect");
  assert.equal(manualAgain.consecutiveFailures, 1);
  assert.equal(step(manualAgain, "hard-broken", 18).phase, "confirmed-broken");
});

test("restricted/transient observations never resolve confirmed findings", () => {
  const first = step(null, "hard-broken", 0);
  const confirmed = step(first, "hard-broken", 6);
  for (const kind of ["restricted", "rate-limited", "timeout", "dns", "network-tls", "server-error", "inconclusive"]) {
    const unknown = step(confirmed, kind, 12);
    assert.equal(unknown.phase, "confirmed-broken", kind);
    assert.equal(unknown.resolved, false);
    const interrupted = step(first, kind, 6);
    assert.equal(step(interrupted, "hard-broken", 12).phase, "suspect");
  }
  assert.equal(classifyHttpStatus(403), "restricted");
  assert.equal(classifyHttpStatus(429), "rate-limited");
  assert.equal(classifyHttpStatus(503), "server-error");
});

test("redirect destinations are candidates, never catalog corrections", () => {
  const redirect = observation("redirect", 200, "https://example.com/new-docs");
  const first = advanceUrl(null, redirect, context(0));
  const second = advanceUrl(first, redirect, context(6));
  assert.equal(second.candidate.confidence, "high");
  assert.equal(second.destinationRuns, 2);
  assert.equal(advanceUrl(second, redirect, context(12, "workflow_dispatch")).destinationRuns, 2);
  for (const target of ["https://example.com/", "https://example.com/login", "https://other.example/docs"]) {
    const obs = observation("redirect", 200, target);
    assert.equal(advanceUrl(advanceUrl(null, obs, context(0)), obs, context(6)).candidate.confidence, "review");
  }
});

test("missing/corrupted state fails closed and valid state round-trips", () => {
  for (const input of [undefined, "{", {}, { schemaVersion: 99, urls: {} }, { schemaVersion: 1, urls: { [url]: { phase: "confirmed-broken" } } }]) {
    const state = parseState(input);
    assert.deepEqual(state, emptyState());
    assert.equal(step(state.urls[url], "hard-broken", 6).phase, "suspect");
  }
  const state = { schemaVersion: 1, urls: { [url]: step(step(null, "hard-broken", 0), "hard-broken", 6) } };
  assert.deepEqual(parseState(JSON.stringify(state)), state);
});

const tool = { id: "demo", name: "Demo", url, lastVerifiedAt: "2026-09-01" };
async function report(classification, hour, state, extra = {}) {
  return buildSourceRecheckReport({ tools: [tool], ...context(hour), state, check: async target => ({ ...target, ...observation(classification, classification === "healthy" ? 200 : classification === "restricted" ? 403 : 404) }), ...extra });
}

test("report integrates persistent findings, recovery, deduplicated URLs and partial scans", async () => {
  const a = await report("hard-broken", 0);
  assert.equal(a.findings.length, 0);
  const b = await report("hard-broken", 6, a.state);
  assert.equal(b.schemaVersion, 2);
  assert.equal(b.findings[0].type, "confirmed-broken");
  assert.equal(b.findings[0].repairEligible, true);
  const c = await report("restricted", 12, b.state);
  assert.equal(c.findings[0].findingId, b.findings[0].findingId);
  assert.equal(c.tools[0].safeToClose, false);
  const d = await report("healthy", 18, c.state);
  assert.equal(d.findings.length, 0);
  assert.equal(d.tools[0].safeToClose, true);
  let calls = 0;
  const shared = await report("healthy", 0, undefined, { tools: [tool, { ...tool, id: "other" }], check: async target => { calls++; return { ...target, ...observation("healthy", 200) }; } });
  assert.equal(calls, 1);
  const retained = await report("healthy", 6, { ...shared.state, urls: { ...shared.state.urls, "https://unused.example/": { ...shared.state.urls[url], originalUrl: "https://unused.example/" } } }, { toolId: "demo" });
  assert.ok(retained.state.urls["https://unused.example/"]);
});

test("Issue lifecycle uses exact markers only, ignores PRs, avoids duplicates and closes after recovery", async () => {
  const a = await report("hard-broken", 0);
  const b = await report("hard-broken", 6, a.state);
  const [create] = planSourceRecheckIssues(b, []);
  assert.equal(create.action, "create");
  const issue = { number: 8, state: "open", title: create.title, body: create.body, labels: create.labels };
  assert.equal(planSourceRecheckIssues(b, [issue, { ...issue, number: 9 }]).length, 1);
  assert.equal(planSourceRecheckIssues(b, [issue])[0].action, "unchanged");
  assert.equal(planSourceRecheckIssues(b, [{ ...issue, body: "no marker" }])[0].action, "create");
  assert.equal(planSourceRecheckIssues(b, [{ ...issue, pull_request: {} }])[0].action, "create");
  assert.equal(planSourceRecheckIssues(await report("restricted", 12, b.state), [issue])[0].action, "update");
  assert.deepEqual(planSourceRecheckIssues(await report("restricted", 12), [issue]), []);
  assert.deepEqual(planSourceRecheckIssues(a, [issue]), []);
  const healthy = await report("healthy", 12, b.state);
  assert.equal(planSourceRecheckIssues(healthy, [issue])[0].action, "close");
  assert.deepEqual(planSourceRecheckIssues({ tools: [] }, [issue]), []);
  const calls = [];
  const result = await applySourceRecheckIssues(healthy, { repo: "owner/repo", token: "test", fetchImpl: async (url, options) => {
    calls.push([url, options.method || "GET", options.body]);
    return { ok: true, status: 200, json: async () => options.method ? {} : [issue] };
  } });
  assert.equal(result.closed, 1);
  assert.equal(calls[1][1], "POST");
  assert.ok(calls[1][0].endsWith("/comments"));
  assert.equal(JSON.parse(calls[2][2]).state, "closed");
});

test("network observations classify DNS timeout TLS and GitHub path separately", async () => {
  const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
  const response = status => ({ status, headers: { get: () => "" }, body: { cancel: async () => {} } });
  const target = { url };
  assert.equal((await checkDeclaredUrl(target, { lookupImpl: async () => { throw Error(); } })).classification, "dns");
  assert.equal((await checkDeclaredUrl(target, { lookupImpl: publicDns, fetchImpl: async () => { throw Error(); } })).classification, "network-tls");
  const timeout = await checkDeclaredUrl(target, { lookupImpl: publicDns, timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("aborted")))) });
  assert.equal(timeout.classification, "timeout");
  const github = await checkDeclaredUrl({ url: "https://github.com/owner/repo/blob/main/old.md" }, { lookupImpl: publicDns, fetchImpl: async url => response(url.endsWith("/repo") ? 200 : 404) });
  assert.equal(github.github.classification, "repository reachable, target path missing");
});

test("all tool findings must resolve; stale verification still blocks closure", async () => {
  const first = await report("hard-broken", 0);
  const confirmed = await report("hard-broken", 6, first.state);
  const [create] = planSourceRecheckIssues(confirmed, []);
  const issue = { number: 1, state: "open", body: create.body, labels: create.labels };
  const stale = await report("healthy", 12, confirmed.state, { tools: [{ ...tool, lastVerifiedAt: "2025-01-01" }] });
  assert.equal(planSourceRecheckIssues(stale, [issue])[0].action, "update");
  const mixed = await report("healthy", 12, confirmed.state, { tools: [{ ...tool, docs: "https://example.com/other" }], check: async target => ({ ...target, ...observation(target.url === url ? "hard-broken" : "healthy", target.url === url ? 404 : 200), originalUrl: target.url, finalUrl: target.url }) });
  assert.equal(mixed.tools[0].actionable.length, 1);
  assert.notEqual(planSourceRecheckIssues(mixed, [issue])[0].action, "close");
});

test("Issue API creates and updates existing marked Issues without creating duplicates", async () => {
  const first = await report("hard-broken", 0);
  const confirmed = await report("hard-broken", 6, first.state);
  let open = [];
  const calls = [];
  const api = async (url, options) => {
    calls.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    if (options.method === "POST" && url.endsWith("/issues")) open = [{ ...JSON.parse(options.body), state: "open", number: 1 }];
    if (options.method === "PATCH") Object.assign(open[0], JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => options.method ? {} : open };
  };
  const options = { repo: "owner/repo", token: "test", fetchImpl: api };
  assert.equal((await applySourceRecheckIssues(confirmed, options)).created, 1);
  assert.equal((await applySourceRecheckIssues(confirmed, options)).unchanged, 1);
  const unknown = await report("restricted", 12, confirmed.state);
  assert.equal((await applySourceRecheckIssues(unknown, options)).updated, 1);
  assert.equal(calls.filter(call => call.method === "POST" && call.url.endsWith("/issues")).length, 1);
});
