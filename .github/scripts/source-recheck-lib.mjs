// Deterministic, side-effect-free policy and Issue planning for official-source
// re-checks. Network and GitHub API calls live in separate scripts.

import { urlFinding } from "./source-recheck-state.mjs";
import { encodeIssuePayload } from "./source-recheck-payload.mjs";

export const STALE_AFTER_DAYS = 90;
export const REQUEST_TIMEOUT_MS = 12_000;
export const MAX_REDIRECTS = 5;
export const CHECK_CONCURRENCY = 5;
export const SOURCE_RECHECK_LABEL = "source-recheck";
export const NEEDS_REVIEW_LABEL = "needs-review";
export const SOURCE_RECHECK_PREFIX = "[Source recheck]";

const HARD_BROKEN = new Set([404, 410]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function cleanText(value) { return typeof value === "string" ? value.trim() : ""; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }

export function canonicalCheckUrl(value = "") {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.href;
  } catch {
    return "";
  }
}

export function isHttpUrl(value = "") {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

export function collectToolCheckTargets(tool = {}, setup = {}) {
  const collected = new Map();
  const add = (kind, value) => {
    const raw = cleanText(value);
    if (!raw) return;
    const url = canonicalCheckUrl(raw) || raw;
    const key = canonicalCheckUrl(raw) || `invalid:${raw}`;
    const existing = collected.get(key);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      return;
    }
    collected.set(key, { toolId: cleanText(tool.id), toolName: cleanText(tool.name), kinds: [kind], url });
  };
  for (const source of Array.isArray(tool.sources) ? tool.sources : []) add("source", source);
  add("website", tool.url);
  add("docs", tool.docs);
  add("github", tool.github);
  for (const envVar of Array.isArray(setup?.envVars) ? setup.envVars : []) add("setup-source", envVar?.source);
  for (const recipe of Array.isArray(setup?.commandRecipes) ? setup.commandRecipes : []) add("setup-source", recipe?.source);
  return [...collected.values()];
}

export function isBlockedHostname(value = "") {
  const host = cleanText(value).replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  return !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

function ipv4Parts(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function ipv6Parts(value) {
  let address = String(value).toLowerCase();
  const mapped = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const ipv4 = ipv4Parts(mapped[2]);
    if (!ipv4) return null;
    address = `${mapped[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if ((address.match(/::/g) || []).length > 1) return null;
  const [left, right] = address.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  if ([...start, ...end].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if (address.includes("::")) {
    const missing = 8 - start.length - end.length;
    if (missing < 1) return null;
    return [...start, ...Array(missing).fill("0"), ...end].map((part) => Number.parseInt(part, 16));
  }
  return start.length === 8 ? start.map((part) => Number.parseInt(part, 16)) : null;
}

export function isIpLiteral(value = "") {
  const host = cleanText(value).replace(/^\[|\]$/g, "");
  return Boolean(ipv4Parts(host)) || (/^[0-9a-f:.]+$/i.test(host) && host.includes(":"));
}

export function isPrivateAddress(value = "") {
  const address = cleanText(value).replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = ipv4Parts(address);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (!isIpLiteral(address)) return false;
  const ipv6 = ipv6Parts(address);
  if (!ipv6) return true;
  if (ipv6.every((part) => part === 0) || (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1)) return true;
  // IPv4-mapped addresses are never needed for public source checks; reject
  // them conservatively instead of risking a mapped private destination.
  if (ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff) return true;
  const first = ipv6[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

export function classifyHttpStatus(status) {
  if (Number.isInteger(status) && status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403) return "restricted";
  if (HARD_BROKEN.has(status)) return "hard-broken";
  if (status === 429) return "rate-limited";
  if (status >= 500 && status < 600) return "server-error";
  return "inconclusive";
}

export function isRedirectStatus(status) { return REDIRECT_STATUSES.has(status); }

// Legacy helper retained for compatibility; never used to confirm production checks.
export function classifyAttemptPair(first = {}, second = null) {
  if (first.classification === "unsafe" || second?.classification === "unsafe") return "unsafe";
  if (first.classification !== "hard-broken") return first.classification || "inconclusive";
  return second?.classification === "hard-broken" ? "broken" : "inconclusive";
}

export function verificationAgeDays(lastVerifiedAt, now = new Date()) {
  const value = cleanText(lastVerifiedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const verified = Date.UTC(year, month - 1, day);
  const parsed = new Date(verified);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - verified) / 86_400_000);
}

export function verificationFinding(lastVerifiedAt, now = new Date(), staleAfterDays = STALE_AFTER_DAYS) {
  const value = cleanText(lastVerifiedAt);
  if (!value) return { type: "verification", code: "missing", message: "Verification date is missing." };
  const ageDays = verificationAgeDays(value, now);
  if (ageDays == null || ageDays < 0) return { type: "verification", code: "invalid", message: "Verification date is invalid or in the future." };
  if (ageDays > staleAfterDays) return { type: "verification", code: "stale", ageDays, message: `Verification is ${ageDays} days old.` };
  return null;
}

export function actionableFindingsForTool(toolResult = {}, now = new Date(), staleAfterDays = STALE_AFTER_DAYS) {
  const findings = [];
  const verification = verificationFinding(toolResult.lastVerifiedAt, now, staleAfterDays);
  if (verification) findings.push({ ...verification, toolId: toolResult.id, findingId: `${toolResult.id}:verification`, repairEligible: false });
  for (const check of Array.isArray(toolResult.checks) ? toolResult.checks : []) {
    if (check.state) {
      if (["confirmed-broken", "unsafe"].includes(check.state.phase)) findings.push(urlFinding(toolResult.id, check));
      continue;
    }
    if (check?.classification !== "broken" && check?.classification !== "unsafe") continue;
    findings.push({
      type: "url",
      code: check.classification,
      kinds: Array.isArray(check.kinds) ? [...check.kinds] : [],
      url: cleanText(check.originalUrl || check.url),
      status: Number.isInteger(check.finalStatus) ? check.finalStatus : null,
      reason: cleanText(check.reason)
    });
  }
  return findings;
}

function markdownText(value) { return cleanText(value).replace(/[\\`*_{}\[\]<>]/g, "\\$&").replace(/[\r\n]+/g, " "); }
function markdownCode(value) { return "`" + cleanText(value).replace(/`/g, "\\`").replace(/[\r\n]+/g, " ") + "`"; }

export function sourceRecheckIssueTitle(tool = {}) {
  const id = cleanText(tool.id).replace(/[\r\n\[\]]/g, "");
  const name = markdownText(tool.name) || id;
  return `${SOURCE_RECHECK_PREFIX}[${id}] ${name}`;
}

export function sourceRecheckMarker(toolId) { return `<!-- ai-dekrov-source-recheck:${cleanText(toolId)} -->`; }

export function sourceRecheckIssueBody(toolResult = {}) {
  const tool = { id: toolResult.id, name: toolResult.name };
  const findings = Array.isArray(toolResult.actionable) ? toolResult.actionable : actionableFindingsForTool(toolResult);
  const lines = [
    "## AI-Dekrov automatic source re-check",
    "",
    `Tool: ${markdownText(tool.name) || markdownCode(tool.id)}`,
    `Tool ID: ${markdownCode(tool.id)}`,
    `Last verified: ${markdownCode(toolResult.lastVerifiedAt || "missing")}`,
    "",
    "### Findings",
    ""
  ];
  for (const finding of findings) {
    if (finding.type === "verification") {
      const message = finding.code === "stale" ? `Verification is older than ${STALE_AFTER_DAYS} days.` : finding.message;
      lines.push(`- ${message}`);
    }
    else if (finding.code === "broken") lines.push(`- ${markdownText((finding.kinds || []).join(", ") || "source")} — ${markdownCode(finding.url)} has confirmed 404/410 observations from separate scheduled runs (latest status: ${finding.status ?? "unknown"}).`);
    else lines.push(`- ${markdownText((finding.kinds || []).join(", ") || "source")} — ${markdownCode(finding.url)} is blocked by safe-network policy${finding.reason ? ` (${markdownText(finding.reason)})` : ""}.`);
  }
  const uncertain = (toolResult.checks || []).filter(check => check.state && !["healthy", "redirect"].includes(check.classification) && !["confirmed-broken", "unsafe"].includes(check.state.phase));
  if (uncertain.length) {
    lines.push("", "### Unconfirmed observations", "", "These observations are not proof of recovery or confirmed broken links; historical findings may still need review.");
    for (const check of uncertain) lines.push(`- ${markdownCode(check.originalUrl)}: ${markdownText(check.classification)} (${check.finalStatus ?? "no HTTP response"}).`);
  }
  lines.push(
    "",
    "### Important",
    "",
    "HTTP reachability is not factual verification. This automation does not modify catalog data, setup metadata, or verification dates.",
    "",
    "A maintainer should inspect the official source, verify factual metadata through the normal trusted path, then close this Issue when satisfied.",
    "",
    sourceRecheckMarker(tool.id),
    "",
    encodeIssuePayload(tool.id, findings)
  );
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 60_000) throw new Error(`Source-recheck Issue for ${tool.id} exceeds the safe body size.`);
  return body;
}

export function planSourceRecheckIssues(report = {}, openIssues = []) {
  const issues = Array.isArray(openIssues) ? openIssues : [];
  return (Array.isArray(report.tools) ? report.tools : [])
    .filter((tool) => Array.isArray(tool.actionable))
    .slice()
    .sort((a, b) => cleanText(a.id).localeCompare(cleanText(b.id)))
    .flatMap((tool) => {
      const title = sourceRecheckIssueTitle(tool);
      const marker = sourceRecheckMarker(tool.id);
      const body = sourceRecheckIssueBody(tool);
      const matches = issues.filter((issue) => !issue.pull_request && issue?.state === "open" && String(issue.body || "").split(/\r?\n/).includes(marker)).sort((a, b) => a.number - b.number);
      const existing = matches[0];
      if (!tool.actionable.length) {
        if (tool.safeToClose !== true) return [];
        return matches.map((issue) => ({ action: "close", toolId: tool.id, issueNumber: issue.number, comment: "Automatic re-check: all tracked findings are resolved or removed from the catalog. HTTP reachability is not factual verification." }));
      }
      const requiredLabels = [SOURCE_RECHECK_LABEL, NEEDS_REVIEW_LABEL];
      if (!existing) return { action: "create", toolId: tool.id, title, body, labels: requiredLabels };
      const labels = new Set((Array.isArray(existing.labels) ? existing.labels : []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean));
      const addLabels = requiredLabels.filter((label) => !labels.has(label));
      if (String(existing.body || "") === body) return { action: "unchanged", toolId: tool.id, issueNumber: existing.number, addLabels };
      return { action: "update", toolId: tool.id, issueNumber: existing.number, body, addLabels };
    });
}

export function formatSourceRecheckSummary(report = {}, issueResult = {}) {
  const summary = object(report.summary) ? report.summary : {};
  const issues = object(issueResult) ? issueResult : {};
  return [
    "## AI-Dekrov official source re-check",
    "",
    `Checked: ${report.checkedAt || "unknown"}`,
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Tools checked | ${report.toolsChecked || 0} |`,
    `| URLs checked | ${report.urlsChecked || 0} |`,
    `| Reachable | ${summary.healthy || 0} |`,
    `| Redirects | ${summary.redirect || 0} |`,
    `| Suspects | ${summary.suspect || 0} |`,
    `| Restricted | ${summary.restricted || 0} |`,
    `| Rate limited | ${summary["rate-limited"] || 0} |`,
    `| Timeouts | ${summary.timeout || 0} |`,
    `| DNS failures | ${summary.dns || 0} |`,
    `| Network/TLS failures | ${summary["network-tls"] || 0} |`,
    `| Server errors | ${summary["server-error"] || 0} |`,
    `| Broken | ${summary.broken || 0} |`,
    `| Inconclusive | ${summary.inconclusive || 0} |`,
    `| Unsafe | ${summary.unsafe || 0} |`,
    `| Stale tools | ${summary.staleTools || 0} |`,
    `| Maintenance Issues created | ${issues.created || 0} |`,
    `| Maintenance Issues updated | ${issues.updated || 0} |`,
    `| Maintenance Issues unchanged | ${issues.unchanged || 0} |`,
    `| Maintenance Issues closed | ${issues.closed || 0} |`,
    "",
    "HTTP reachability never refreshes `lastVerifiedAt` and this workflow never edits catalog data."
  ].join("\n");
}
