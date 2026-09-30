// A bounded, versioned transport embedded in Issue bodies. It is data, never
// authorization or agent instructions. Ownership is checked separately by marker.
export const PAYLOAD_START = "<!-- ai-dekrov-source-recheck-data:v1 -->";
export const PAYLOAD_END = "<!-- ai-dekrov-source-recheck-data:end -->";
export const MAX_PAYLOAD_BYTES = 48_000;

export function encodeIssuePayload(toolId, findings) {
  const payload = { schemaVersion: 1, toolId, findings: findings.filter(f => f.repairEligible === true) };
  const json = JSON.stringify(payload, null, 2).replace(/[<>&`]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new Error("Source-recheck Issue payload is too large; use the report artifact for manual review.");
  return `${PAYLOAD_START}\n\`\`\`json\n${json}\n\`\`\`\n${PAYLOAD_END}`;
}

export function decodeIssuePayload(issue) {
  if (issue?.state !== "open" || issue.pull_request || !Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error("Expected an open GitHub Issue, not a PR.");
  const body = issue.body;
  if (typeof body !== "string" || Buffer.byteLength(body) > 65_536) throw new Error("Invalid Issue body.");
  if (body.split(PAYLOAD_START).length !== 2 || body.split(PAYLOAD_END).length !== 2) throw new Error("Issue has no unique v1 repair payload; wait for a fresh source-recheck run.");
  const section = body.split(PAYLOAD_START)[1].split(PAYLOAD_END)[0].replace(/\r\n/g, "\n").trim();
  if (!section.startsWith("```json\n") || !section.endsWith("\n```")) throw new Error("Invalid repair payload fence.");
  const json = section.slice(8, -4);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new Error("Repair payload is too large.");
  const payload = JSON.parse(json);
  if (payload?.schemaVersion !== 1 || typeof payload.toolId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.toolId) || !Array.isArray(payload.findings)) throw new Error("Invalid repair payload schema.");
  const marker = `<!-- ai-dekrov-source-recheck:${payload.toolId} -->`;
  if (!body.split(/\r?\n/).includes(marker)) throw new Error("Issue ownership marker does not match its payload.");
  if (payload.findings.some(f => f.toolId !== payload.toolId)) throw new Error("Mixed tool IDs in repair payload.");
  return payload;
}
