import { createHash } from "node:crypto";

export const MIN_CONFIRMATION_MS = 5 * 60 * 60 * 1000;
const classes = new Set(["healthy", "redirect", "restricted", "hard-broken", "rate-limited", "timeout", "dns", "network-tls", "server-error", "unsafe", "inconclusive"]);
export const emptyState = () => ({ schemaVersion: 1, urls: {} });

// Fail closed: invalid history must never manufacture confirmation.
export function parseState(raw) {
  try {
    const state = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (state?.schemaVersion !== 1 || !state.urls || typeof state.urls !== "object" || Array.isArray(state.urls)) return emptyState();
    for (const [url, entry] of Object.entries(state.urls)) {
      if (!entry || entry.originalUrl !== url || !classes.has(entry.lastClassification) ||
          !["unknown", "healthy", "suspect", "confirmed-broken", "unsafe"].includes(entry.phase) ||
          !Number.isSafeInteger(entry.consecutiveFailures) || entry.consecutiveFailures < 0 ||
          !Number.isSafeInteger(entry.destinationRuns) || entry.destinationRuns < 0 ||
          !Number.isFinite(Date.parse(entry.lastCheckedAt)) ||
          typeof entry.lastRunId !== "string" || typeof entry.finalUrl !== "string" ||
          !Array.isArray(entry.redirectChain) || !Number.isSafeInteger(entry.redirectCount) || entry.redirectCount < 0 ||
          (entry.lastStatus !== null && (!Number.isInteger(entry.lastStatus) || entry.lastStatus < 100 || entry.lastStatus > 599)) ||
          [entry.lastSuccessAt, entry.lastFailureAt].some(value => value !== null && !Number.isFinite(Date.parse(value))) ||
          (entry.scheduledFailure && (!Number.isFinite(Date.parse(entry.scheduledFailure.at)) || typeof entry.scheduledFailure.runId !== "string" || ![404, 410].includes(entry.scheduledFailure.status) || entry.consecutiveFailures < 1)) ||
          (entry.phase === "confirmed-broken" && (!entry.scheduledFailure || entry.consecutiveFailures < 2 ||
            !entry.confirmation || entry.confirmation.runId === entry.scheduledFailure.runId ||
            ![404, 410].includes(entry.confirmation.status) || ![404, 410].includes(entry.scheduledFailure.status) ||
            !Number.isFinite(Date.parse(entry.confirmation.at)) ||
            Date.parse(entry.confirmation.at) - Date.parse(entry.scheduledFailure.at) < MIN_CONFIRMATION_MS))) return emptyState();
    }
    return structuredClone(state);
  } catch { return emptyState(); }
}

export function advanceUrl(previous, observation, { now, event = "workflow_dispatch", runId = "local" }) {
  const at = now.toISOString();
  const kind = observation.classification;
  const healthy = kind === "healthy" || kind === "redirect";
  const broken = kind === "hard-broken";
  const independent = event === "schedule" && previous?.lastRunId !== runId;
  const baseline = previous?.scheduledFailure;
  const canConfirm = independent && baseline && baseline.runId !== runId &&
    now.getTime() - Date.parse(baseline.at) >= MIN_CONFIRMATION_MS;
  let phase = previous?.phase || "unknown";
  let failures = previous?.consecutiveFailures || 0;
  let scheduledFailure = baseline || null;
  if (healthy) { phase = "healthy"; failures = 0; scheduledFailure = null; }
  else if (broken) {
    if (phase !== "confirmed-broken") phase = canConfirm ? "confirmed-broken" : "suspect";
    if (independent) {
      failures += 1;
      scheduledFailure ||= { at, runId, status: observation.finalStatus };
    }
  } else {
    // Transient observations interrupt an unconfirmed streak, but never resolve
    // a confirmed failure or an unsafe URL.
    if (phase !== "confirmed-broken") { failures = 0; scheduledFailure = null; }
    if (kind === "unsafe") phase = "unsafe";
  }
  const redirected = healthy && observation.redirects > 0;
  const sameDestination = redirected && previous?.finalUrl === observation.finalUrl && previous?.lastClassification === "redirect";
  const destinationRuns = redirected ? (sameDestination ? previous.destinationRuns + (independent ? 1 : 0) : (event === "schedule" ? 1 : 0)) : 0;
  let candidate = null;
  if (redirected) {
    const from = new URL(observation.originalUrl);
    const to = new URL(observation.finalUrl);
    const sameDomain = from.hostname === to.hostname;
    const suspicious = to.pathname === "/" || /(?:login|signin|sign-in|auth)(?:\/|$)/i.test(to.pathname);
    candidate = { url: to.href, sameDomain, destinationRuns, confidence: sameDomain && destinationRuns >= 2 && !suspicious ? "high" : "review", requiresContentVerification: true };
  }
  return {
    originalUrl: observation.originalUrl, lastCheckedAt: at,
    lastSuccessAt: healthy ? at : previous?.lastSuccessAt || null,
    lastFailureAt: broken || kind === "unsafe" ? at : previous?.lastFailureAt || null,
    lastStatus: observation.finalStatus ?? null, lastClassification: kind,
    finalUrl: observation.finalUrl, redirectChain: observation.redirectChain || [],
    redirectCount: observation.redirects || 0, destinationRuns, candidate,
    consecutiveFailures: failures, scheduledFailure, phase, lastRunId: runId,
    confirmation: healthy ? null : broken && canConfirm ? { at, runId, status: observation.finalStatus } : previous?.confirmation || null,
    unsafeReason: kind === "unsafe" ? observation.reason || "" : healthy ? "" : previous?.unsafeReason || "",
    resolved: healthy && ["suspect", "confirmed-broken", "unsafe"].includes(previous?.phase)
  };
}

export function urlFinding(toolId, check) {
  const state = check.state;
  const type = state.phase;
  const originalUrl = check.originalUrl;
  return {
    findingId: createHash("sha256").update(`${toolId}\n${originalUrl}`).digest("hex"),
    toolId, kind: check.kinds?.[0] || "source", kinds: check.kinds || [], type,
    // Compatibility with the existing Issue renderer.
    code: type === "confirmed-broken" ? "broken" : "unsafe", url: originalUrl,
    originalUrl, status: check.finalStatus ?? null, finalUrl: check.finalUrl,
    consecutiveFailures: state.consecutiveFailures, firstScheduledFailure: state.scheduledFailure,
    confirmation: state.confirmation,
    lastCheckedAt: state.lastCheckedAt, lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt, observation: check.classification,
    reason: type === "unsafe" ? state.unsafeReason : check.reason || "", github: check.github || null,
    repairEligible: type === "confirmed-broken",
    evidence: type === "confirmed-broken" ? "Separated scheduled HTTP 404/410 observations; retained until recovery." : "Blocked by safe-network policy."
  };
}
