import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyInboxTriage,
  buildInboxFeed,
  campaignInboxInput,
  campaignsToScan,
  countInboxReplies,
  flattenCampaignInbox,
  inboxReplyBucket,
  mergeAndSortReplies,
  normalizeReplyCategory,
  parseInboxTriage,
  readInboxTriage,
  writeInboxTriage,
} from "../api/inbox/_lib/core.mjs";
import {
  createInboxFeedHandler,
} from "../api/inbox/feed.mjs";
import {
  createInboxTriageHandler,
} from "../api/inbox/triage.mjs";

function mockResponse() {
  return {
    body: null,
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("live campaign inbox rows keep only nested inbound email and join lead metadata", () => {
  const rows = flattenCampaignInbox(
    { id: "sequence-1", name: "Platform search", can_reply: true },
    {
      campaign_to_candidate_users: [
        {
          id: "lead-1",
          reply_category: " interested ",
          tracking_status: "opened",
          is_archived: true,
          candidate_user: {
            emails: [{ email: "ada@example.com" }],
            candidate: {
              name: "Ada Lovelace",
              image_src: "https://images.example/ada.png",
              linkedin_user: "https://www.linkedin.com/in/ada",
              experiences: [
                {
                  is_current: true,
                  title: "Staff Engineer",
                  company: { name: "Analytical Engines" },
                },
              ],
            },
          },
        },
      ],
      campaign_emails: [
        {
          campaign_to_candidate_user_id: "lead-1",
          email: {
            gmail_id: "gmail-inbound",
            thread_id: "thread-1",
            sent_from_paraform: false,
            subject: " Re: Platform role ",
            snippet: "I would like to learn more.",
            email_date: "2026-07-16T18:00:00.000Z",
            attachments: [{ id: "attachment-1" }],
          },
        },
        {
          campaign_to_candidate_user_id: "lead-1",
          email: {
            gmail_id: "gmail-outbound",
            sent_from_paraform: true,
            subject: "Platform role",
          },
        },
        {
          campaign_to_candidate_user_id: "lead-1",
          email: {
            gmail_id: "gmail-unknown-direction",
            subject: "Direction is required",
          },
        },
      ],
    },
  );

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    candidate_name: "Ada Lovelace",
    candidate_email: "ada@example.com",
    candidate_image: "https://images.example/ada.png",
    candidate_linkedin_url: "https://www.linkedin.com/in/ada",
    candidate_one_liner: "Staff Engineer at Analytical Engines",
    sequence_name: "Platform search",
    sequence_id: "sequence-1",
    subject: "Re: Platform role",
    snippet: "I would like to learn more.",
    date: "2026-07-16T18:00:00.000Z",
    gmail_id: "gmail-inbound",
    thread_id: "thread-1",
    ccu_id: "lead-1",
    reply_category: "INTERESTED",
    tracking_status: "OPENED",
    is_archived: true,
    can_reply: true,
    attachment_count: 1,
  });
});

test("reply categories normalize Paraform values and fail closed to NA", () => {
  assert.equal(normalizeReplyCategory("INTERESTED"), "INTERESTED");
  assert.equal(normalizeReplyCategory(" not_interested "), "NOT_INTERESTED");
  assert.equal(normalizeReplyCategory("unclear"), "UNCLEAR");
  assert.equal(normalizeReplyCategory(""), "NA");
  assert.equal(normalizeReplyCategory("unexpected"), "NA");
  assert.equal(normalizeReplyCategory(null), "NA");
});

test("triage overlay assigns one effective bucket and recomputes active counts", () => {
  const base = {
    generated_at: "2026-07-17T18:00:00.000Z",
    replies: [
      {
        gmail_id: "gmail-active",
        reply_category: "INTERESTED",
        is_archived: false,
      },
      {
        gmail_id: "gmail-archived",
        reply_category: "INTERESTED",
        is_archived: false,
      },
      {
        gmail_id: "gmail-complete",
        reply_category: "UNCLEAR",
        is_archived: true,
      },
      {
        gmail_id: "gmail-paraform-archived",
        reply_category: "NOT_INTERESTED",
        is_archived: true,
      },
    ],
  };
  const triage = parseInboxTriage([
    "gmail-archived",
    JSON.stringify({
      status: "archived",
      updated_at: "2026-07-17T18:01:00.000Z",
    }),
    "gmail-complete",
    JSON.stringify({
      status: "complete",
      updated_at: "2026-07-17T18:02:00.000Z",
    }),
  ]);

  const feed = applyInboxTriage(base, triage);
  assert.deepEqual(
    feed.replies.map((reply) => inboxReplyBucket(reply)),
    ["active", "archived", "complete", "archived"],
  );
  assert.equal(feed.replies[0].triage_status, null);
  assert.equal(feed.replies[1].triage_status, "archived");
  assert.equal(feed.replies[2].triage_status, "complete");
  assert.deepEqual(feed.counts, {
    total: 4,
    interested: 1,
    needs_review: 0,
    not_interested: 0,
    archived: 2,
    complete: 1,
  });

  const restored = {
    ...feed.replies[2],
    triage_status: null,
  };
  assert.equal(inboxReplyBucket(restored), "archived");
  assert.deepEqual(countInboxReplies([restored]), {
    total: 1,
    interested: 0,
    needs_review: 0,
    not_interested: 0,
    archived: 1,
    complete: 0,
  });
});

test("triage hash parsing ignores orphan fields but fails closed on corrupt records", () => {
  const valid = {
    "gmail-valid": JSON.stringify({
      status: "complete",
      updated_at: "2026-07-17T18:00:00.000Z",
    }),
    "contains spaces": JSON.stringify({ status: "archived" }),
  };
  const triage = parseInboxTriage(valid);
  assert.deepEqual([...triage.entries()], [[
    "gmail-valid",
    {
      status: "complete",
      updated_at: "2026-07-17T18:00:00.000Z",
    },
  ]]);
  assert.throws(
    () => parseInboxTriage({
      ...valid,
      "gmail-invalid-status": JSON.stringify({ status: "later" }),
    }),
    { code: "INVALID_TRIAGE_RECORD" },
  );
  assert.throws(
    () => parseInboxTriage({
      ...valid,
      "gmail-invalid-json": "{",
    }),
    { code: "INVALID_TRIAGE_RECORD" },
  );
});

test("triage reads fail closed when a valid stored record is corrupt", async () => {
  const read = await readInboxTriage({
    configured: true,
    kvImpl: async () => [
      "gmail-corrupt",
      JSON.stringify({ status: "unknown" }),
    ],
  });
  assert.deepEqual(read, { status: "error", value: null });
});

test("triage storage writes, reads back, and restores durable hash state", async () => {
  const hash = new Map();
  const commands = [];
  const kvImpl = async (args) => {
    commands.push(args);
    const [command, , field, value] = args;
    if (command === "EVAL") {
      const gmailId = args[4];
      const record = args[5];
      if (record === undefined) {
        hash.delete(gmailId);
        return 0;
      }
      hash.set(gmailId, record);
      return record;
    }
    if (command === "HGETALL") return [...hash.entries()].flat();
    throw new Error(`Unexpected command ${command}`);
  };

  const saved = await writeInboxTriage("gmail-1", "archived", {
    kvImpl,
    now: () => new Date("2026-07-17T18:00:00.000Z"),
  });
  assert.deepEqual(saved, {
    gmail_id: "gmail-1",
    status: "archived",
    updated_at: "2026-07-17T18:00:00.000Z",
  });
  const read = await readInboxTriage({ kvImpl, configured: true });
  assert.equal(read.status, "ready");
  assert.equal(read.value.get("gmail-1").status, "archived");

  const restored = await writeInboxTriage("gmail-1", null, { kvImpl });
  assert.deepEqual(restored, {
    gmail_id: "gmail-1",
    status: null,
    updated_at: null,
  });
  assert.equal(hash.has("gmail-1"), false);
  assert.equal(commands.some((args) => args.includes("EX")), false);
});

test("triage endpoint authenticates, validates, and returns confirmed state", async () => {
  let writes = 0;
  const unauthenticated = createInboxTriageHandler({
    corsHandler: () => false,
    authHandler: async (_req, res) => {
      res.status(401).json({ ok: false, error: "auth_required" });
      return false;
    },
    storeReady: () => true,
    writeTriage: async () => {
      writes += 1;
    },
  });
  const unauthenticatedResponse = mockResponse();
  await unauthenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { gmail_id: "gmail-1", status: "archived" },
  }, unauthenticatedResponse);
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(writes, 0);

  const calls = [];
  const handler = createInboxTriageHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    storeReady: () => true,
    writeTriage: async (gmailId, status) => {
      calls.push([gmailId, status]);
      return {
        gmail_id: gmailId,
        status,
        updated_at: status ? "2026-07-17T18:00:00.000Z" : null,
      };
    },
  });
  const unsupportedResponse = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ gmail_id: "gmail-1", status: "complete" }),
  }, unsupportedResponse);
  assert.equal(unsupportedResponse.statusCode, 415);
  assert.equal(unsupportedResponse.body.error, "unsupported_media_type");
  assert.equal(calls.length, 0);

  const invalidResponse = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { gmail_id: "gmail-1", status: "later" },
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.body.error, "invalid_triage_status");

  const response = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ gmail_id: "gmail-1", status: "complete" }),
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    gmail_id: "gmail-1",
    status: "complete",
    updated_at: "2026-07-17T18:00:00.000Z",
  });

  const restoreResponse = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { gmail_id: "gmail-1", status: "inbox" },
  }, restoreResponse);
  assert.equal(restoreResponse.statusCode, 200);
  assert.deepEqual(calls, [
    ["gmail-1", "complete"],
    ["gmail-1", null],
  ]);
});

test("cold feed builds apply the latest triage read before responding", async () => {
  const triageReads = [
    new Map([[
      "gmail-1",
      { status: "archived", updated_at: "2026-07-17T18:00:00.000Z" },
    ]]),
    new Map([[
      "gmail-1",
      { status: "complete", updated_at: "2026-07-17T18:01:00.000Z" },
    ]]),
  ];
  let readCount = 0;
  let released = "";
  const handler = createInboxFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    readCache: async () => ({ status: "miss", value: null }),
    readTriage: async () => ({
      status: "ready",
      value: triageReads[readCount++],
    }),
    acquireLock: async () => ({ status: "acquired", token: "lock-1" }),
    buildFeed: async () => ({
      generated_at: "2026-07-17T18:00:00.000Z",
      partial: false,
      cacheable: true,
      replies: [{
        gmail_id: "gmail-1",
        reply_category: "INTERESTED",
        is_archived: false,
      }],
      counts: {},
      scan: {},
    }),
    writeCache: async () => true,
    releaseLock: async (token) => {
      released = token;
      return true;
    },
  });
  const response = mockResponse();
  await handler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(readCount, 2);
  assert.equal(released, "lock-1");
  assert.equal(response.body.replies[0].triage_status, "complete");
  assert.deepEqual(response.body.counts, {
    total: 1,
    interested: 0,
    needs_review: 0,
    not_interested: 0,
    archived: 0,
    complete: 1,
  });
  assert.deepEqual(response.body.cache, {
    status: "stored",
    lock: "acquired",
  });
});

test("campaign selection retains disabled reply history when aggregate counts exist", () => {
  const selected = campaignsToScan([
    { id: "disabled-history", status: "DISABLED", email_replies: 4 },
    { id: "active-empty", status: "ACTIVE", email_replies: 0 },
    { id: "disabled-empty", status: "DISABLED", email_replies: "0" },
    { id: "", email_replies: 8 },
  ]);
  assert.deepEqual(selected.map(({ id }) => id), ["disabled-history"]);

  const withMixedCounts = campaignsToScan([
    { id: "active-counted", status: "ACTIVE", email_replies: 0 },
    { id: "disabled-unknown", status: "DISABLED" },
  ]);
  assert.deepEqual(
    withMixedCounts.map(({ id }) => id),
    ["active-counted", "disabled-unknown"],
  );
});

test("company sequence inbox reads include the live audience discriminator", () => {
  assert.deepEqual(
    campaignInboxInput({ id: "company-sequence", kind: " company " }),
    { campaign_id: "company-sequence", audience: "company" },
  );
  assert.deepEqual(
    campaignInboxInput({ id: "candidate-sequence", kind: "CANDIDATE" }),
    { campaign_id: "candidate-sequence" },
  );
});

test("fanout rows win duplicate Gmail IDs and merged replies sort newest first", () => {
  const rows = [
    {
      gmail_id: "gmail-duplicate",
      sequence_id: "sequence-1",
      ccu_id: "lead-1",
      candidate_name: "Fanout candidate",
      subject: "Fanout copy",
      date: "2026-07-15T12:00:00.000Z",
    },
    {
      gmail_id: "",
      sequence_id: "sequence-1",
      ccu_id: "lead-2",
      candidate_name: "Composite key candidate",
      subject: "No Gmail ID",
      date: "2026-07-14T12:00:00.000Z",
    },
  ];
  const recent = [
    {
      id: "lead-1",
      gmail_id: "gmail-duplicate",
      sequence_id: "sequence-1",
      candidate_name: "Recent duplicate",
      email_subject: "Recent copy",
      email_date: "2026-07-17T12:00:00.000Z",
    },
    {
      id: "lead-3",
      gmail_id: "gmail-new",
      sequence_id: "sequence-1",
      candidate_name: "Recent candidate",
      email_subject: "Newest unique reply",
      email_date: "2026-07-16T12:00:00.000Z",
    },
    {
      id: "lead-2",
      gmail_id: "",
      sequence_id: "sequence-1",
      candidate_name: "Composite duplicate",
      email_subject: "No Gmail ID",
      email_date: "2026-07-14T12:00:00.000Z",
    },
  ];
  const merged = mergeAndSortReplies(
    rows,
    recent,
    [{ id: "sequence-1", name: "Sequence one", can_reply: true }],
    new Map([[
      "sequence-1:lead-3",
      { reply_category: "unclear", is_archived: true },
    ]]),
  );

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map(({ gmail_id, candidate_name }) => [gmail_id, candidate_name]),
    [
      ["gmail-new", "Recent candidate"],
      ["gmail-duplicate", "Fanout candidate"],
      ["", "Composite key candidate"],
    ],
  );
  assert.equal(merged[0].sequence_name, "Sequence one");
  assert.equal(merged[0].reply_category, "UNCLEAR");
  assert.equal(merged[0].is_archived, true);
  assert.equal(merged[0].can_reply, true);
});

test("feed building bounds fanout and returns partial metadata with recent fallback", async () => {
  const campaigns = [
    {
      id: "sequence-live",
      name: "Live sequence",
      email_replies: 1,
      can_reply: true,
    },
    {
      id: "sequence-failed",
      name: "Failed disabled sequence",
      status: "DISABLED",
      email_replies: 2,
    },
    {
      id: "sequence-recent",
      name: "Company sequence",
      kind: "COMPANY",
      email_replies: 1,
      can_reply: true,
    },
    { id: "sequence-empty", name: "Empty sequence", email_replies: 0 },
  ];
  const recentReplies = [
    {
      id: "lead-recent",
      sequence_id: "sequence-recent",
      candidate_name: "Grace Hopper",
      candidate_email: "grace@example.com",
      email_subject: "Re: Company search",
      email_snippet: "Happy to discuss.",
      email_date: "2026-07-16T20:00:00.000Z",
      gmail_id: "gmail-recent",
      attachment_count: 2,
    },
  ];
  const inboxCalls = [];
  let active = 0;
  let maxActive = 0;

  const get = async (procedure, input) => {
    if (procedure === "campaigns.getListOfCampaignsOptimized") return campaigns;
    if (procedure === "campaigns.getRecentReplies") return recentReplies;
    assert.equal(procedure, "campaigns.getCampaignInboxData");
    inboxCalls.push(input);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (input.campaign_id === "sequence-failed") {
        const error = new Error("upstream unavailable");
        error.code = "PARAFORM_DOWN";
        throw error;
      }
      if (input.campaign_id === "sequence-recent") {
        return {
          campaign_emails: [],
          campaign_to_candidate_users: [{
            id: "lead-recent",
            reply_category: "unclear",
            is_archived: true,
          }],
        };
      }
      return {
        campaign_to_candidate_users: [{
          id: "lead-live",
          reply_category: "interested",
          candidate_email: "live@example.com",
          candidate_user: { candidate: { name: "Live Candidate" } },
        }],
        campaign_emails: [{
          campaign_to_candidate_user_id: "lead-live",
          email: {
            gmail_id: "gmail-live",
            sent_from_paraform: false,
            subject: "Live reply",
            email_date: "2026-07-15T20:00:00.000Z",
          },
        }],
      };
    } finally {
      active -= 1;
    }
  };

  const feed = await buildInboxFeed({
    get,
    concurrency: 2,
    now: () => new Date("2026-07-16T21:00:00.000Z"),
  });

  assert.equal(maxActive, 2);
  assert.equal(inboxCalls.length, 3);
  assert.deepEqual(
    inboxCalls.find(({ campaign_id }) => campaign_id === "sequence-recent"),
    { campaign_id: "sequence-recent", audience: "company" },
  );
  assert.equal(feed.generated_at, "2026-07-16T21:00:00.000Z");
  assert.equal(feed.partial, true);
  assert.equal(feed.cacheable, false);
  assert.deepEqual(
    feed.replies.map(({ gmail_id, reply_category }) => [gmail_id, reply_category]),
    [
      ["gmail-recent", "UNCLEAR"],
      ["gmail-live", "INTERESTED"],
    ],
  );
  assert.equal(feed.replies[0].is_archived, true);
  assert.equal(feed.replies[0].attachment_count, 2);
  assert.equal(feed.replies[0].can_reply, true);
  assert.deepEqual(feed.counts, {
    total: 2,
    interested: 1,
    needs_review: 0,
    not_interested: 0,
    archived: 1,
    complete: 0,
  });
  assert.deepEqual(feed.scan, {
    campaigns_total: 4,
    campaigns_attempted: 3,
    campaigns_succeeded: 2,
    campaigns_failed: 1,
    recent_count: 1,
    recent_failed: false,
    failures: [{
      sequence_id: "sequence-failed",
      sequence_name: "Failed disabled sequence",
      error: "PARAFORM_DOWN",
    }],
  });
});

test("standalone page, dashboard tab, and Vercel routing are wired together", async () => {
  const [inboxHtml, indexHtml, vercelRaw] = await Promise.all([
    readFile(new URL("../inbox.html", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);
  const vercel = JSON.parse(vercelRaw);

  assert.match(inboxHtml, /<script src="\/auth-session\.js"><\/script>/);
  assert.match(inboxHtml, /RaydarAuth\.session\(\)/);
  assert.match(inboxHtml, /RaydarAuth\.signIn\(/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/feed"/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/message\?gmail_id="/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/triage"/);
  assert.match(inboxHtml, /data-filter="archived"/);
  assert.match(inboxHtml, /data-filter="complete"/);
  assert.match(inboxHtml, /class="gmail-nav" aria-label="Inbox views"/);
  assert.match(inboxHtml, /id="viewToggle"[^>]*href="\/inbox\?style=classic"[^>]*>Classic view/);
  assert.match(inboxHtml, /const GMAIL_VIEW=VIEW_PARAMS\.get\("style"\)!=="classic"/);
  assert.match(inboxHtml, /document\.body\.classList\.add\(GMAIL_VIEW\?"gmail":"classic"\)/);
  assert.match(inboxHtml, /GMAIL_VIEW\?"Classic view":"Gmail view"/);
  assert.match(inboxHtml, /body\.gmail \.reply-open\{display:grid/);
  assert.match(inboxHtml, /body\.gmail\.reading \.detail\{display:block\}/);
  assert.match(inboxHtml, /className="back-control gmail-only"/);
  assert.match(inboxHtml, /className="message-copy"/);
  assert.match(inboxHtml, /triageControl\(reply,"Archive","archived"/);
  assert.match(inboxHtml, /triageControl\(reply,"Complete","complete"/);
  assert.match(inboxHtml, /triageControl\(reply,"Restore","inbox"/);
  assert.match(inboxHtml, /STATE\.triageRevision\+=1/);
  assert.match(
    inboxHtml,
    /triageRevisionAtStart!==STATE\.triageRevision[\s\S]*?queueFeedRefresh\(\)/,
  );
  assert.match(inboxHtml, /role="group" aria-label="Reply filters"/);
  assert.match(inboxHtml, /data-filter="complete" aria-pressed="false"/);
  assert.match(inboxHtml, /item\.setAttribute\("aria-pressed"/);
  assert.match(inboxHtml, /item\.dataset\.filter===STATE\.filter/);
  assert.match(inboxHtml, /Archived in Paraform/);
  assert.match(inboxHtml, /\.chip\.archived\{[^}]*color:#8A4F0E/);
  assert.match(
    inboxHtml,
    /const focusToken=captureInboxFocus\(\);[\s\S]*?requestAnimationFrame\(\(\)=>restoreInboxFocus\(focusToken\)\)/,
  );
  assert.match(
    inboxHtml,
    /document\.activeElement===sourceButton[\s\S]*?selectAfterTriage\(previousIndex,shouldFocusNext\)/,
  );
  assert.match(inboxHtml, /showTriageBanner\("good","Moved to Complete\."\)/);
  assert.match(inboxHtml, /State unavailable/);
  assert.doesNotMatch(
    inboxHtml,
    /id="replyList"[^>]*aria-live/,
  );
  const inlineScript = [...inboxHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .at(-1)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));

  assert.match(indexHtml, /id="tab-inbox"/);
  assert.match(indexHtml, /id="view-inbox"[^>]*hidden/);
  assert.match(indexHtml, /<iframe id="inbox-frame"/);
  assert.match(
    indexHtml,
    /name==="inbox" && !inboxLoaded[\s\S]*?src="\/inbox\?embed=1"[\s\S]*?inboxLoaded=true/,
  );

  assert.deepEqual(
    vercel.rewrites.find(({ source }) => source === "/inbox"),
    { source: "/inbox", destination: "/inbox.html" },
  );
  assert.deepEqual(
    vercel.rewrites.find(({ source }) => source === "/inbox-classic"),
    { source: "/inbox-classic", destination: "/inbox.html?style=classic" },
  );
  assert.deepEqual(
    vercel.functions["api/inbox/*.mjs"],
    { maxDuration: 120 },
  );
});
