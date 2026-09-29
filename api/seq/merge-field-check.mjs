// SEQUENCE MERGE-FIELD CHECK: a read-only cron that flags any Paraform
// sequence step holding a typed placeholder such as `{Candidate First Name}`,
// which Paraform sends to candidates word for word (27 sequences on
// 2026-09-29, one live for ~458 sends). Detection and the read plan live in
// ./_lib/merge-field-check.mjs.
//
//   cron (CRON_SECRET bearer)  -> one pass: catalog read, then a few paced
//                                 campaigns.getCampaign reads, then one Slack
//                                 post per new incident
//   GET ?run=1[&dry=1] signed in -> the same pass, by hand (dry: no post)
//   GET ?detail=1 signed in      -> flagged sequences with names and steps
//   GET                          -> public counts only (the System Health tile)
//
// It never edits a sequence. It honours the dashboard-readers background
// pause, and without its KV state it makes no Paraform request at all.
import {
  CONFIG,
  cors,
  cronAuth,
  ensureParaformSession,
  hasCookie,
  requireAuth,
  trpcGet,
} from "./_lib/core.mjs";
import { shouldAlert } from "./_lib/booking-stop.mjs";
import { paraformBackgroundPauseState } from "../_lib/paraform-background-pause.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import {
  flaggedDetail,
  runMergeFieldCheck,
  STATE_SCHEMA,
} from "./_lib/merge-field-check.mjs";

// A pass stops reading at 75 s, but one read can still ride core.mjs's
// 401 ladder (about 31 s, twice if it switches cookie) before the Slack post
// and the state save. 300 s keeps a killed function (no state saved) out of
// reach.
export const config = { maxDuration: 300 };

const STATE_KEY = "seq:v1:merge-field-check:state";
const LOCK_KEY = "seq:v1:merge-field-check:lock";
const STATE_TTL_SECONDS = 30 * 24 * 3600;
const LOCK_TTL_SECONDS = 330;

async function kv(command, env = process.env) {
  const url = String(env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = String(env.KV_REST_API_TOKEN || "");
  if (!url || !token) throw new Error("KV_UNCONFIGURED");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`KV_HTTP_${response.status}`);
  const body = await response.json().catch(() => null);
  if (!body || body.error) throw new Error("KV_ERROR");
  return body.result ?? null;
}

async function loadState() {
  const raw = await kv(["GET", STATE_KEY]);
  return raw == null ? null : JSON.parse(raw);
}

async function saveState(state) {
  await kv(["SET", STATE_KEY, JSON.stringify(state), "EX", String(STATE_TTL_SECONDS)]);
}

function publicSummary(state) {
  const lastPass = state?.schema === STATE_SCHEMA ? state.lastPass : null;
  return {
    ok: true,
    check: "seq-merge-field-check",
    lastOkAt: state?.lastOkAt ?? null,
    lastPass: lastPass && {
      at: lastPass.at,
      status: lastPass.status,
      error: lastPass.error ?? null,
      catalogSequences: lastPass.catalogSequences ?? null,
      liveSequences: lastPass.liveSequences ?? null,
      stoppedAt: lastPass.stoppedAt ?? null,
      reads: lastPass.reads ?? null,
      readErrors: lastPass.readErrors ?? null,
      deferred: lastPass.deferred ?? null,
      neverChecked: lastPass.neverChecked ?? null,
      flaggedLive: lastPass.flaggedLive ?? null,
      flaggedOff: lastPass.flaggedOff ?? null,
      alertFailed: lastPass.alertFailed ?? null,
    },
  };
}

// A scheduled tick that cannot authenticate would otherwise just read the
// public counts, and the tile would take 3 h to notice.
async function warnOnCronRejection(cron) {
  if (await shouldAlert(`merge-field-check-cron-auth-${cron.reason}`, 3600)) {
    await notifySlack(`:warning: A request to /api/seq/merge-field-check carried \`x-vercel-cron\` but no valid CRON_SECRET bearer (${cron.reason}). Sequences are not being checked for typed merge fields while scheduled ticks cannot authenticate.`).catch(() => {});
  }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const params = new URL(req.url, "http://x").searchParams;
  const cron = cronAuth(req);
  const run = cron.ok || params.get("run") === "1";
  const detail = params.get("detail") === "1";
  if (!cron.ok && cron.headerPresent) await warnOnCronRejection(cron);
  if (!cron.ok && (run || detail) && !(await requireAuth(req, res))) return;

  if (!run) {
    let state;
    try { state = await loadState(); }
    catch { return res.status(200).json({ ok: false, error: "state_unavailable" }); }
    if (!detail) return res.status(200).json(publicSummary(state));
    return res.status(200).json({ ...publicSummary(state), flagged: flaggedDetail(state) });
  }

  // One pass at a time: an overlapping manual run would double the reads.
  let locked;
  try { locked = (await kv(["SET", LOCK_KEY, String(Date.now()), "NX", "EX", String(LOCK_TTL_SECONDS)])) === "OK"; }
  catch { return res.status(200).json({ ok: false, error: "state_unavailable" }); }
  if (!locked) return res.status(200).json({ ok: false, error: "locked" });

  try {
    const result = await runMergeFieldCheck({
      loadState,
      saveState,
      pauseState: () => paraformBackgroundPauseState("dashboardReaders"),
      sessionReady: async () => { await ensureParaformSession(); return hasCookie(); },
      // One try each: a failed read waits for the next pass, not a retry.
      listCatalog: () => trpcGet("campaigns.getListOfCampaignsOptimized", {}, 1),
      readCampaign: (id) => trpcGet("campaigns.getCampaign", { campaign_id: id }, 1),
      send: notifySlack,
      exemptInsertIds: [CONFIG.TEMPLATE_ID],
      alert: params.get("dry") !== "1",
    });
    return res.status(200).json(result);
  } finally {
    await kv(["DEL", LOCK_KEY]).catch(() => {});
  }
}
