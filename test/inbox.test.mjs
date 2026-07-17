import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildInboxFeed,
  campaignInboxInput,
  campaignsToScan,
  flattenCampaignInbox,
  mergeAndSortReplies,
  normalizeReplyCategory,
} from "../api/inbox/_lib/core.mjs";

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
    vercel.functions["api/inbox/*.mjs"],
    { maxDuration: 120 },
  );
});
