import { readFile, writeFile } from "node:fs/promises";
import { planSourceRecheckIssues } from "./source-recheck-lib.mjs";

function argsFrom(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    args[key] = inline ?? values[index + 1];
    if (inline == null) index += 1;
  }
  return args;
}

export async function applySourceRecheckIssues(report, { repo, token, fetchImpl = fetch } = {}) {
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set.");
  const base = `https://api.github.com/repos/${repo}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "AI-Dekrov-Source-Recheck/1.0" };
  const github = async (pathname, options = {}) => {
    const response = await fetchImpl(base + pathname, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`GitHub API ${options.method || "GET"} ${pathname} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
  const openIssues = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/issues?state=open&per_page=100&page=${page}`);
    openIssues.push(...batch);
    if (batch.length < 100) break;
  }
  const plan = planSourceRecheckIssues(report, openIssues);
  const result = { created: 0, updated: 0, unchanged: 0, closed: 0 };
  for (const item of plan) {
    if (item.action === "close") {
      await github(`/issues/${item.issueNumber}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: item.comment }) });
      await github(`/issues/${item.issueNumber}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
      result.closed += 1;
      continue;
    }
    if (item.action === "create") {
      await github("/issues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: item.title, body: item.body, labels: item.labels }) });
      result.created += 1;
      continue;
    }
    if (item.action === "update") {
      await github(`/issues/${item.issueNumber}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: item.body }) });
      result.updated += 1;
    } else if (item.addLabels?.length) result.updated += 1;
    else result.unchanged += 1;
    if (item.addLabels?.length) await github(`/issues/${item.issueNumber}/labels`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labels: item.addLabels }) });
  }
  return result;
}

async function runCli() {
  const args = argsFrom(process.argv.slice(2));
  if (!args.report || !args.output) throw new Error("Pass --report <path> and --output <path>.");
  const report = JSON.parse(await readFile(args.report, "utf8"));
  const result = await applySourceRecheckIssues(report, { repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
  await writeFile(args.output, JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith("apply-source-recheck-issues.mjs")) runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
