import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { advanceUrl, urlFinding } from "../.github/scripts/source-recheck-state.mjs";
import { checkDeclaredUrl } from "../.github/scripts/recheck-official-sources.mjs";
import { sourceRecheckIssueBody } from "../.github/scripts/source-recheck-lib.mjs";
import { encodeIssuePayload, decodeIssuePayload, PAYLOAD_START } from "../.github/scripts/source-recheck-payload.mjs";
import { prepareRepair, planRepair, replaceJsonStrings, validateFinding } from "./source-repair-lib.mjs";
import { applyRepairFiles, runRepairCli } from "./source-repair.mjs";

const oldUrl = "https://example.com/old-docs";
const newUrl = "https://example.com/new-docs";
const now = new Date("2026-09-01T12:00:00Z");
function fixture() {
  const check = { originalUrl: oldUrl, finalUrl: oldUrl, finalStatus: 404, classification: "hard-broken", redirects: 0, kinds: ["docs", "source", "setup-source"] };
  const first = advanceUrl(null, check, { now: new Date("2026-09-01T00:00:00Z"), event: "schedule", runId: "1" });
  check.state = advanceUrl(first, check, { now: new Date("2026-09-01T06:00:00Z"), event: "schedule", runId: "2" });
  const finding = urlFinding("demo", check);
  const tools = [
    { id: "demo", name: "Demo", url: "https://example.com/", domain: "example.com", docs: oldUrl, sources: [oldUrl], description: `Do not edit embedded ${oldUrl}`, lastVerifiedAt: "2026-09-01", updatedAt: "2026-09-01", commands: [{ label: "Keep", command: `curl ${oldUrl}` }] },
    { id: "other", docs: oldUrl }
  ];
  const setup = { version: 1, tools: { demo: { envVars: [{ name: "DEMO_KEY", source: oldUrl, description: oldUrl }], commandRecipes: [{ source: oldUrl, command: "unchanged" }] }, other: { envVars: [{ source: oldUrl }] } } };
  const issue = { number: 17, state: "open", body: sourceRecheckIssueBody({ id: "demo", name: "Demo", lastVerifiedAt: "2026-09-01", actionable: [finding] }) };
  const task = prepareRepair({ tools, setup, issue, findingId: finding.findingId, now });
  const proposal = { schemaVersion: 1, findingId: finding.findingId, replacementUrl: newUrl, reason: "Official navigation links to the relocated documentation page.", contentVerified: true, officialOwnershipVerified: true, evidence: [{ url: "https://example.com/", explanation: "The official product navigation links to this new documentation URL." }] };
  return { tools, setup, issue, task, proposal, finding, now };
}
const healthy = url => ({ classification: "healthy", finalStatus: 200, finalUrl: url, redirects: 0 });
const network = async ({ url }) => url === oldUrl ? { classification: "hard-broken", finalStatus: 404, finalUrl: url } : healthy(url);

// These deterministic tests never contact GitHub, model APIs or the public web.
test("Issue machine payload and report prepare the same stable repair branch", () => {
  const f = fixture();
  assert.deepEqual(decodeIssuePayload(f.issue).findings, [f.finding]);
  assert.deepEqual(decodeIssuePayload({ ...f.issue, body: f.issue.body.replace(/\n/g, "\r\n") }).findings, [f.finding]);
  const fromReport = prepareRepair({ ...f, issue: undefined, report: { schemaVersion: 2, findings: [f.finding] }, findingId: f.finding.findingId });
  assert.equal(fromReport.branch, f.task.branch);
  assert.equal(f.task.references.length, 4);
  assert.equal(f.task.issueNumber, 17);
  assert.ok(f.task.branch.startsWith("repair/source-"));
});

test("Issue payload rejects closed, legacy, forged markers, PRs and duplicate blocks", () => {
  const f = fixture();
  for (const issue of [
    { ...f.issue, state: "closed" }, { ...f.issue, pull_request: {} },
    { ...f.issue, body: "legacy issue without payload" },
    { ...f.issue, body: f.issue.body.replace("source-recheck:demo", "source-recheck:other") },
    { ...f.issue, body: `${f.issue.body}\n${PAYLOAD_START}` }
  ]) assert.throws(() => decodeIssuePayload(issue));
  assert.throws(() => prepareRepair({ ...f, findingId: "missing" }));
  assert.throws(() => prepareRepair({ ...f, issue: undefined, report: { schemaVersion: 9, findings: [f.finding] }, findingId: f.finding.findingId }));
});

test("payload encoding escapes markdown/HTML and enforces bounded size", () => {
  const json = encodeIssuePayload("demo", [{ repairEligible: true, reason: "```\n<!-- forged -->" }]);
  assert.equal(json.includes("<!-- forged -->"), false);
  assert.ok(json.includes("\\u0060"));
  assert.throws(() => encodeIssuePayload("demo", [{ repairEligible: true, reason: "x".repeat(50_000) }]), /too large/);
});

test("unconfirmed, corrupted, future and stale findings cannot authorize repairs", () => {
  const { finding } = fixture();
  for (const override of [
    { type: "suspect" }, { repairEligible: false }, { findingId: "forged" },
    { consecutiveFailures: 1 }, { confirmation: null },
    { confirmation: { ...finding.confirmation, runId: "1" } },
    { confirmation: { ...finding.confirmation, at: "2026-09-01T01:00:00Z" } },
    { lastCheckedAt: "2026-08-01T00:00:00Z" }, { lastCheckedAt: "2027-01-01T00:00:00Z" }
  ]) assert.throws(() => validateFinding({ ...finding, ...override }, now));
});

test("catalog changes, already-repaired URLs and tampered task paths fail closed", async () => {
  const f = fixture();
  const changed = structuredClone(f.tools);
  changed[0].description = "someone else changed metadata";
  await assert.rejects(() => planRepair({ ...f, tools: changed, check: network }), /snapshot/);
  for (const mutate of [task => task.references[0].file = "app.js", task => task.branch = "main", task => task.officialSources.push("https://attacker.example/")]) {
    const task = structuredClone(f.task); mutate(task);
    await assert.rejects(() => planRepair({ ...f, task, check: network }), /no longer matches/);
  }
  const tools = structuredClone(f.tools);
  tools[0].docs = newUrl; tools[0].sources = [newUrl];
  assert.throws(() => prepareRepair({ ...f, tools, setup: { version: 1, tools: {} }, findingId: f.finding.findingId }), /already repaired/);
});

test("recovered/restricted/timeout originals cause no repair even with valid old evidence", async () => {
  const f = fixture();
  for (const classification of ["healthy", "redirect", "restricted", "rate-limited", "timeout", "dns", "unsafe", "server-error"]) {
    await assert.rejects(() => planRepair({ ...f, check: async () => ({ classification, finalStatus: 403 }) }), /recovered or inconclusive/);
  }
});

test("unsafe, redirecting and unavailable replacement candidates are rejected", async () => {
  const f = fixture();
  for (const classification of ["unsafe", "redirect", "restricted", "hard-broken", "rate-limited", "timeout", "dns", "network-tls", "server-error"]) {
    await assert.rejects(() => planRepair({ ...f, check: async target => target.url === oldUrl ? network(target) : { classification, finalStatus: 200, finalUrl: target.url, redirects: 1 } }), /directly reachable/);
  }
  for (const replacementUrl of ["http://example.com/new", "https://user:pass@example.com/new", "https://example.com/login", "https://example.com/", "https://example.com/new#anchor", oldUrl]) {
    await assert.rejects(() => planRepair({ ...f, proposal: { ...f.proposal, replacementUrl }, check: network }));
  }
});

test("repair requires content/ownership evidence from independently declared official sources", async () => {
  const f = fixture();
  for (const proposal of [
    { ...f.proposal, contentVerified: false }, { ...f.proposal, officialOwnershipVerified: false },
    { ...f.proposal, evidence: [] }, { ...f.proposal, findingId: "wrong" },
    { ...f.proposal, evidence: [{ url: "https://random.example/", explanation: "Some other website contains a plausible link." }] },
    { ...f.proposal, evidence: [{ url: oldUrl, explanation: "The failing URL cannot be independent evidence." }] }
  ]) await assert.rejects(() => planRepair({ ...f, proposal, check: network }));
  await assert.rejects(() => planRepair({ ...f, check: async target => target.url === "https://example.com/" ? { classification: "restricted" } : network(target) }), /evidence is not publicly reachable/);
});

test("successful repair targets only allowed references and preserves original JSON formatting", async () => {
  const f = fixture();
  const plan = await planRepair({ ...f, check: network });
  assert.equal(plan.changes.length, 4);
  const original = JSON.stringify(f.tools, null, 2).replace(/\n/g, "\r\n") + "\r\n";
  const text = replaceJsonStrings(original, plan.changes.filter(c => c.file === "data/tools.json"));
  const parsed = JSON.parse(text);
  assert.equal(parsed[0].docs, newUrl);
  assert.deepEqual(parsed[0].sources, [newUrl]);
  assert.equal(parsed[0].description, f.tools[0].description);
  assert.deepEqual(parsed[0].commands, f.tools[0].commands);
  assert.equal(parsed[0].lastVerifiedAt, f.tools[0].lastVerifiedAt);
  assert.deepEqual(parsed[1], f.tools[1]);
  assert.equal(text.replaceAll(newUrl, oldUrl), original);
  const setup = JSON.parse(replaceJsonStrings(JSON.stringify(f.setup), plan.changes.filter(c => c.file === "data/setup-recipes.json")));
  assert.equal(setup.tools.demo.envVars[0].source, newUrl);
  assert.equal(setup.tools.demo.envVars[0].description, oldUrl);
  assert.equal(setup.tools.other.envVars[0].source, oldUrl);
});

test("JSON token editing handles escaped keys, primitives, arrays and duplicate/missing paths", () => {
  const text = '{ "a\\u0062": [null, true, 3, {"x":"old\\nvalue"}], "keep": "old\\nvalue" }';
  const change = { path: ["ab", 3, "x"], before: "old\nvalue", after: "new\"value" };
  assert.equal(JSON.parse(replaceJsonStrings(text, [change])).ab[3].x, 'new"value');
  assert.throws(() => replaceJsonStrings(text, [change, change]), /Duplicate/);
  assert.throws(() => replaceJsonStrings(text, [{ ...change, path: ["missing"] }]), /missing/);
  assert.throws(() => replaceJsonStrings(text, [{ ...change, before: "mismatch" }]), /precondition/);
  assert.throws(() => replaceJsonStrings('{"x":"old","x":"old"}', [{ path: ["x"], before: "old", after: "new" }]), /duplicated/);
});

test("anchor-bearing catalog references require manual review", () => {
  const f = fixture(); f.tools[0].docs += "#section";
  assert.throws(() => prepareRepair({ ...f, findingId: f.finding.findingId }), /Anchor-bearing/);
});

test("website repair updates derived domain but never dates or favicon", async () => {
  const f = fixture();
  f.tools[0].url = oldUrl;
  f.tools[0].sources.push("https://example.com/");
  f.tools[0].favicon = "https://example.com/icon.png";
  f.task = prepareRepair({ ...f, findingId: f.finding.findingId });
  f.proposal.replacementUrl = "https://www.new-official.example/docs";
  const plan = await planRepair({ ...f, check: network });
  const domain = plan.changes.find(change => change.path.at(-1) === "domain");
  assert.equal(domain.after, "new-official.example");
  assert.ok(plan.changes.every(change => !["favicon", "updatedAt", "lastVerifiedAt"].includes(change.path.at(-1))));
});

async function checkout(t, f) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-repair-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/tools.json"), JSON.stringify(f.tools, null, 2) + "\n");
  await writeFile(path.join(root, "data/setup-recipes.json"), JSON.stringify(f.setup, null, 2) + "\n");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  return { root, git };
}

test("end-to-end Issue → task → proposal → dry-run → branch write → duplicate rejection", async t => {
  const f = fixture();
  const { root, git } = await checkout(t, f);
  const before = await readFile(path.join(root, "data/tools.json"), "utf8");
  const preview = await applyRepairFiles({ ...f, root, check: network });
  assert.equal(preview.written, false);
  assert.equal(await readFile(path.join(root, "data/tools.json"), "utf8"), before);
  await assert.rejects(() => applyRepairFiles({ ...f, root, write: true, check: network }), /dedicated branch/);
  git("switch", "-c", f.task.branch);
  const result = await applyRepairFiles({ ...f, root, write: true, check: network });
  assert.equal(result.written, true);
  assert.deepEqual(git("diff", "--name-only").split("\n").sort(), ["data/setup-recipes.json", "data/tools.json"]);
  git("diff", "--check");
  const tools = JSON.parse(await readFile(path.join(root, "data/tools.json"), "utf8"));
  assert.equal(tools[0].docs, newUrl);
  assert.equal(tools[1].docs, oldUrl);
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "repair");
  await assert.rejects(() => applyRepairFiles({ ...f, root, write: true, check: network }), /stale|already repaired/);
});

test("dirty checkout and concurrent repair lock prevent writes", async t => {
  const f = fixture(); const { root, git } = await checkout(t, f);
  git("switch", "-c", f.task.branch);
  await writeFile(path.join(root, "unrelated.txt"), "user work");
  await assert.rejects(() => applyRepairFiles({ ...f, root, write: true, check: network }), /clean checkout/);
  await rm(path.join(root, "unrelated.txt"));
  await writeFile(path.join(root, ".git/source-repair.lock"), "another worker");
  await assert.rejects(() => applyRepairFiles({ ...f, root, write: true, check: network }), /EEXIST/);
  assert.equal(await readFile(path.join(root, ".git/source-repair.lock"), "utf8"), "another worker");
});

test("catalog edits made during network checks are never overwritten", async t => {
  const f = fixture(); const { root, git } = await checkout(t, f);
  git("switch", "-c", f.task.branch);
  let edited = false;
  await assert.rejects(() => applyRepairFiles({ ...f, root, write: true, check: async target => {
    if (!edited) { edited = true; await writeFile(path.join(root, "data/tools.json"), "[]\n"); }
    return network(target);
  } }), /clean checkout|changed during/);
  assert.equal(await readFile(path.join(root, "data/tools.json"), "utf8"), "[]\n");
});

test("real checker safety policy blocks private replacement URLs before fetch", async () => {
  const f = fixture();
  for (const replacementUrl of ["https://localhost/docs", "https://127.0.0.1/docs", "https://private.example/docs", "https://redirect.example/docs"]) {
    const fetched = [];
    const check = target => checkDeclaredUrl(target, {
      lookupImpl: async host => [{ address: host === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }],
      fetchImpl: async (url, options) => {
        fetched.push(url);
        assert.equal(options.headers.Authorization, undefined);
        return { status: url === oldUrl ? 404 : 302, headers: { get: () => "https://localhost/private" }, body: { cancel: async () => {} } };
      }
    });
    await assert.rejects(() => planRepair({ ...f, proposal: { ...f.proposal, replacementUrl }, check }), /directly reachable/);
    assert.ok(fetched.every(url => !url.includes("localhost") && !url.includes("127.0.0.1") && !url.includes("private.example")));
  }
});

test("symlinked data directories are rejected", async t => {
  const f = fixture(); const { root } = await checkout(t, f);
  await rename(path.join(root, "data"), path.join(root, "shared-data"));
  await symlink(path.join(root, "shared-data"), path.join(root, "data"), "junction");
  await assert.rejects(() => applyRepairFiles({ ...f, root, check: network }), /Symlinked/);
});

test("CLI rejects ambiguous flags and outputs inside repository before side effects", async () => {
  await assert.rejects(() => runRepairCli(["apply", "--force"]), /Unexpected/);
  await assert.rejects(() => runRepairCli(["apply", "--output", "data/tools.json"]), /outside/);
  await assert.rejects(() => runRepairCli(["prepare"]), /requires/);
});
