import { createHash } from "node:crypto";
import { canonicalCheckUrl, collectToolCheckTargets } from "../.github/scripts/source-recheck-lib.mjs";
import { MIN_CONFIRMATION_MS } from "../.github/scripts/source-recheck-state.mjs";
import { decodeIssuePayload } from "../.github/scripts/source-recheck-payload.mjs";
import { checkDeclaredUrl } from "../.github/scripts/recheck-official-sources.mjs";

export const MAX_TASK_AGE_MS = 48 * 60 * 60 * 1000;
const hash = value => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

export function validateFinding(finding, now = new Date()) {
  requireThat(finding && finding.type === "confirmed-broken" && finding.repairEligible === true, "Only confirmed-broken findings are repair eligible.");
  requireThat(typeof finding.toolId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(finding.toolId), "Invalid tool ID.");
  requireThat(typeof finding.originalUrl === "string" && /^https?:\/\//.test(finding.originalUrl) && canonicalCheckUrl(finding.originalUrl) === finding.originalUrl, "Invalid canonical original URL.");
  requireThat(finding.findingId === hash(`${finding.toolId}\n${finding.originalUrl}`), "Finding ID does not match its tool and URL.");
  requireThat(Number.isSafeInteger(finding.consecutiveFailures) && finding.consecutiveFailures >= 2, "Missing failure count.");
  const first = finding.firstScheduledFailure;
  const second = finding.confirmation;
  requireThat(first && second && [first, second].every(item => typeof item.runId === "string" && item.runId && [404, 410].includes(item.status) && Number.isFinite(Date.parse(item.at))), "Missing scheduled confirmation evidence.");
  requireThat(first.runId !== second.runId && Date.parse(second.at) - Date.parse(first.at) >= MIN_CONFIRMATION_MS, "Confirmation requires independent separated scheduled runs.");
  const age = now.getTime() - Date.parse(finding.lastCheckedAt);
  requireThat(Number.isFinite(age) && age >= 0 && age <= MAX_TASK_AGE_MS && Date.parse(second.at) <= Date.parse(finding.lastCheckedAt), "Finding is stale or has invalid timestamps; request a fresh re-check.");
  return finding;
}

export function selectFinding({ issue, report, findingId, now = new Date() }) {
  requireThat(Boolean(issue) !== Boolean(report), "Supply exactly one Issue or report.");
  const payload = issue ? decodeIssuePayload(issue) : report;
  if (report) requireThat(report.schemaVersion === 2 && Array.isArray(report.findings), "Expected a source-recheck v2 report.");
  const matches = payload.findings.filter(f => f.findingId === findingId);
  requireThat(matches.length === 1, "Finding must appear exactly once in the current payload.");
  return validateFinding(matches[0], now);
}

function toolContext(tools, setup, toolId) {
  requireThat(Array.isArray(tools) && setup?.version === 1 && setup.tools && typeof setup.tools === "object" && !Array.isArray(setup.tools), "Invalid catalog/setup data.");
  const indices = tools.flatMap((tool, index) => tool.id === toolId ? [index] : []);
  requireThat(indices.length === 1, "Tool must exist exactly once in the current catalog.");
  const index = indices[0];
  return { tool: tools[index], index, setupTool: setup.tools[toolId] || {} };
}

export function locateReferences(tools, setup, finding) {
  const { tool, index, setupTool } = toolContext(tools, setup, finding.toolId);
  const references = [];
  const add = (file, path, value) => {
    if (typeof value === "string" && canonicalCheckUrl(value) === finding.originalUrl) references.push({ file, path, before: value });
  };
  for (const key of ["url", "docs", "github"]) add("data/tools.json", [index, key], tool[key]);
  (tool.sources || []).forEach((value, i) => add("data/tools.json", [index, "sources", i], value));
  for (const list of ["envVars", "commandRecipes"]) (setupTool[list] || []).forEach((entry, i) => add("data/setup-recipes.json", ["tools", finding.toolId, list, i, "source"], entry.source));
  return references;
}

export function prepareRepair({ tools, setup, issue, report, findingId, now = new Date() }) {
  const finding = selectFinding({ issue, report, findingId, now });
  const context = toolContext(tools, setup, finding.toolId);
  const references = locateReferences(tools, setup, finding);
  requireThat(references.length > 0, "Original URL is no longer declared; task is stale or already repaired.");
  requireThat(!references.some(ref => new URL(ref.before).hash), "Anchor-bearing references need a manually reviewed replacement per anchor; automatic replacement is disabled.");
  return {
    schemaVersion: 1, finding, issueNumber: issue?.number || null,
    branch: `repair/source-${finding.findingId}`,
    prMarker: `<!-- ai-dekrov-source-repair:${finding.findingId} -->`,
    snapshot: hash(JSON.stringify(context)), references,
    officialSources: collectToolCheckTargets(context.tool, context.setupTool).map(target => target.url)
  };
}

function refreshTask(task, tools, setup, now) {
  requireThat(task?.schemaVersion === 1, "Unsupported repair task version.");
  const expected = prepareRepair({ tools, setup, report: { schemaVersion: 2, findings: [task.finding] }, findingId: task.finding?.findingId, now });
  for (const key of ["snapshot", "references", "branch", "prMarker", "officialSources"]) requireThat(same(task[key], expected[key]), `Task ${key} no longer matches current data; prepare a fresh task.`);
  requireThat(task.issueNumber === null || (Number.isSafeInteger(task.issueNumber) && task.issueNumber > 0), "Invalid Issue number.");
}

function httpsUrl(value) {
  requireThat(typeof value === "string" && value.length <= 4096 && value === value.trim(), "Expected a bounded URL string.");
  const url = new URL(value);
  requireThat(url.protocol === "https:" && !url.username && !url.password && !url.hash, "Replacement/evidence must be HTTPS without credentials or fragments.");
  return url;
}

function permittedEvidence(task) {
  const urls = new Set(task.officialSources.map(canonicalCheckUrl));
  // A public repository root is a bounded official-source probe, not arbitrary
  // content hosted by another account on github.com.
  for (const source of task.officialSources) {
    const url = new URL(source);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts.length >= 2) urls.add(`https://github.com/${parts[0]}/${parts[1]}`);
  }
  urls.delete(task.finding.originalUrl);
  return urls;
}

// No discovery model is called here. The agent supplies a proposal and content
// evidence; this gate independently checks freshness, scope and reachability.
export async function planRepair({ task, proposal, tools, setup, now = new Date(), check = checkDeclaredUrl }) {
  refreshTask(task, tools, setup, now);
  requireThat(proposal?.schemaVersion === 1 && proposal.findingId === task.finding.findingId, "Proposal does not match the repair task.");
  requireThat(Object.keys(proposal).every(key => ["schemaVersion", "findingId", "replacementUrl", "reason", "contentVerified", "officialOwnershipVerified", "evidence"].includes(key)), "Unexpected proposal fields.");
  requireThat(proposal.contentVerified === true && proposal.officialOwnershipVerified === true, "Agent must verify both relevant content and official ownership.");
  requireThat(typeof proposal.reason === "string" && proposal.reason.trim().length >= 20 && proposal.reason.length <= 2000, "A bounded explanation of the replacement is required.");
  const replacement = httpsUrl(proposal.replacementUrl);
  const replacementUrl = replacement.href;
  requireThat(canonicalCheckUrl(replacementUrl) !== task.finding.originalUrl, "Replacement must differ from original URL.");
  const deepReference = task.references.some(ref => ref.path.includes("docs") || ref.path.includes("github") || ref.file === "data/setup-recipes.json");
  requireThat(!/(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(replacement.pathname) && !(deepReference && replacement.pathname === "/"), "Homepage/login is not an automatic documentation replacement.");
  const evidence = proposal.evidence;
  requireThat(Array.isArray(evidence) && evidence.length >= 1 && evidence.length <= 5, "Provide one to five official evidence references.");
  const allowed = permittedEvidence(task);
  for (const item of evidence) {
    httpsUrl(item?.url);
    requireThat(Object.keys(item).every(key => ["url", "explanation"].includes(key)), "Unexpected evidence fields.");
    requireThat(allowed.has(canonicalCheckUrl(item.url)), "Evidence must be an independently declared official source or its GitHub repository root.");
    requireThat(typeof item.explanation === "string" && item.explanation.trim().length >= 20 && item.explanation.length <= 2000, "Explain how each source establishes ownership and relevance.");
  }
  const old = await check({ url: task.finding.originalUrl });
  requireThat(old.classification === "hard-broken" && [404, 410].includes(old.finalStatus), "Original URL is recovered or inconclusive; stop and request re-check, do not edit.");
  const candidate = await check({ url: replacementUrl });
  requireThat(candidate.classification === "healthy" && candidate.finalStatus >= 200 && candidate.finalStatus < 300 && candidate.finalUrl === replacementUrl && !candidate.redirects, "Replacement must be a safe, directly reachable final 2xx URL; inspect any redirects first.");
  for (const item of evidence) {
    const observed = await check({ url: item.url });
    requireThat(["healthy", "redirect"].includes(observed.classification), "Official evidence is not publicly reachable; manual review required.");
  }
  const changes = task.references.map(ref => ({ ...ref, after: replacementUrl }));
  const { tool, index } = toolContext(tools, setup, task.finding.toolId);
  if (changes.some(ref => same(ref.path, [index, "url"])) && typeof tool.domain === "string") {
    const domain = replacement.hostname.replace(/^www\./, "");
    if (domain !== tool.domain) changes.push({ file: "data/tools.json", path: [index, "domain"], before: tool.domain, after: domain });
  }
  const evidenceJson = JSON.stringify({ reason: proposal.reason, evidence }, null, 2).replace(/[<>&`]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return {
    schemaVersion: 1, findingId: task.finding.findingId, branch: task.branch,
    changes,
    prTitle: `Fix official source URL for ${task.finding.toolId}`,
    prBody: [task.prMarker, "", `Tool: ${task.finding.toolId}`, task.issueNumber ? `Related maintenance Issue: #${task.issueNumber} (not automatically closed).` : "Source: maintenance report.", "", `Original URL: ${task.finding.originalUrl}`, `Replacement URL: ${replacementUrl}`, "", "Agent-supplied content evidence (not automatically verified):", "```json", evidenceJson, "```",  "", "Run npm test and inspect the exact diff before opening this PR. Reachability alone does not establish factual correctness. Verification dates are unchanged."].join("\n")
  };
}

// Locate JSON string values structurally, then replace ONLY those tokens. No
// reserialization of the 1MB catalog, no global text replacement, no key writes.
export function replaceJsonStrings(text, changes) {
  JSON.parse(text);
  const wanted = new Map(changes.map(change => [JSON.stringify(change.path), change]));
  requireThat(wanted.size === changes.length, "Duplicate replacement paths.");
  const edits = [];
  let cursor = 0;
  const space = () => { while (/\s/.test(text[cursor] || "") && cursor < text.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor++] === '"') break;
    }
    return { start, end: cursor, value: JSON.parse(text.slice(start, cursor)) };
  };
  const value = path => {
    space();
    if (text[cursor] === '"') {
      const token = string();
      const change = wanted.get(JSON.stringify(path));
      if (change) {
        requireThat(token.value === change.before && typeof change.after === "string", "Replacement precondition failed.");
        edits.push({ ...token, after: JSON.stringify(change.after) });
      }
    } else if (text[cursor] === "{") {
      cursor++; space();
      if (text[cursor] !== "}") while (true) {
        space(); const key = string().value; space(); cursor++;
        value([...path, key]); space();
        if (text[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (text[cursor] === "[") {
      cursor++; space(); let index = 0;
      if (text[cursor] !== "]") while (true) {
        value([...path, index++]); space();
        if (text[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else { while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++; }
  };
  value([]);
  requireThat(edits.length === wanted.size, "Replacement paths are missing, duplicated, or not string values.");
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
  JSON.parse(result);
  return result;
}
