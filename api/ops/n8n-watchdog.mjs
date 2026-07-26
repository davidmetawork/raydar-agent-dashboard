// n8n FAILURE WATCHDOG — the alarm the whole instance was missing.
//
// The 2026-07-26 incident: the Sequence Booking Guardian failed every day for
// nine days and nobody learned of it. Not because the alert was misrouted, but
// because there was none: the workflow had no Slack node, no error branch, and
// **no workflow on the entire n8n instance has `errorWorkflow` set**. Silence
// meant "fine" when it meant "dead".
//
// The idiomatic n8n fix is a shared error workflow, but that has to be attached
// to each workflow one at a time and a newly-created workflow starts unprotected
// — the same gap, waiting to reopen. This polls n8n's execution history instead,
// so every workflow (including ones that do not exist yet) is covered by
// construction. Free code over n8n, per the standing rule.
//
// READ-ONLY against n8n: it lists executions and nothing else. It never edits,
// activates, deactivates or re-runs a workflow.
import { notifySlack } from "../paraai/_lib/core.mjs";
import { kvGet, kvSet, shouldAlert, kvConfigured } from "../seq/_lib/booking-stop.mjs";

export const config = { maxDuration: 60 };

const STATE_KEY = "seqguard:n8nwatch";
// A workflow that fails this many consecutive scheduled runs is broken, not flaky.
const CONSECUTIVE_FAILURES_TO_ALERT = Number(process.env.N8N_WATCH_FAIL_STREAK || 2);

function isCron(req) {
  if (req.headers["x-vercel-cron"]) return true;
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers["authorization"] || "") === `Bearer ${secret}`) return true;
  return false;
}

async function n8n(path) {
  const base = String(process.env.N8N_BASE_URL || "").replace(/\/+$/, "");
  const key = process.env.N8N_API_KEY || "";
  if (!base || !key) return null;
  const r = await fetch(`${base}${path}`, {
    headers: { "X-N8N-API-KEY": key, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`n8n ${r.status}`);
  return r.json();
}

/** Newest-first executions per workflow -> current consecutive failure streak. */
export function failureStreaks(executions) {
  const byWorkflow = new Map();
  for (const e of executions) {
    if (e.mode === "manual") continue; // a human poking at it is not an outage
    const id = e.workflowId;
    if (!byWorkflow.has(id)) byWorkflow.set(id, []);
    byWorkflow.get(id).push(e);
  }
  const out = [];
  for (const [id, runs] of byWorkflow) {
    runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    let streak = 0;
    for (const r of runs) {
      if (r.status === "error" || r.status === "crashed") streak++;
      else break;
    }
    if (streak > 0) {
      out.push({
        workflowId: id,
        streak,
        lastFailedAt: runs[0]?.startedAt || null,
        lastSuccessAt: runs.find((r) => r.status === "success")?.startedAt || null,
      });
    }
  }
  return out.sort((a, b) => b.streak - a.streak);
}

export default async function handler(req, res) {
  if (!isCron(req)) {
    const secret = process.env.CRON_SECRET;
    if (!secret || (req.headers["authorization"] || "") !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }
  if (!process.env.N8N_BASE_URL || !process.env.N8N_API_KEY) {
    return res.status(200).json({ ok: false, error: "n8n_not_configured" });
  }

  try {
    const [wfRes, exRes] = await Promise.all([
      n8n("/api/v1/workflows?limit=250"),
      n8n("/api/v1/executions?limit=250"),
    ]);
    const names = new Map((wfRes?.data || []).map((w) => [w.id, { name: w.name, active: w.active }]));
    const streaks = failureStreaks(exRes?.data || []).filter((s) => names.get(s.workflowId)?.active !== false);

    const prev = (await kvGet(STATE_KEY)) || { alerted: {} };
    const alerted = { ...(prev.alerted || {}) };
    const firing = streaks.filter((s) => s.streak >= CONSECUTIVE_FAILURES_TO_ALERT);

    const fresh = [];
    for (const s of firing) {
      // Re-alert only when it gets worse, so a long outage does not spam — but a
      // recovery followed by a new break does alert again.
      if ((alerted[s.workflowId] || 0) >= s.streak) continue;
      alerted[s.workflowId] = s.streak;
      fresh.push(s);
    }
    // Clear state for anything that recovered, so a future break re-alerts.
    for (const id of Object.keys(alerted)) {
      if (!streaks.some((s) => s.workflowId === id)) delete alerted[id];
    }

    if (fresh.length && (await shouldAlert("n8n-failures", 3600))) {
      const lines = fresh.map((s) => {
        const nm = names.get(s.workflowId)?.name || s.workflowId;
        const since = s.lastSuccessAt ? `last success ${String(s.lastSuccessAt).slice(0, 16)}Z` : "no success on record";
        return `• *${nm}* — ${s.streak} consecutive failures (${since})`;
      });
      await notifySlack(`:rotating_light: n8n workflows are failing repeatedly:\n${lines.join("\n")}`).catch(() => {});
    }

    if (kvConfigured()) await kvSet(STATE_KEY, { alerted, checkedAt: new Date().toISOString() });

    return res.status(200).json({
      ok: true,
      workflowsScanned: names.size,
      executionsScanned: (exRes?.data || []).length,
      failing: streaks.map((s) => ({ name: names.get(s.workflowId)?.name || s.workflowId, streak: s.streak })),
      alertedNow: fresh.length,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    // The watchdog going quiet is the failure mode it exists to prevent, so its
    // own breakage is loud.
    if (await shouldAlert("n8n-watchdog-error", 6 * 3600)) {
      await notifySlack(`:rotating_light: n8n watchdog could not read execution history: ${String(e?.message || e).slice(0, 140)}. n8n failures are currently unmonitored.`).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
