// Every email lane that leaves Raydar carrying a Raydar identity, plus the
// reader robots that share the same mailbox quota.
//
// THIS FILE IS THE SOURCE OF TRUTH for the Emails page. Edit it when a lane
// changes; the page renders straight from it. Live status is NOT here: it is
// merged at request time from the Health board via `healthId`.
//
// Provenance: extracted from source and verified lane by lane on 2026-08-17
// (see docs.raydar.xyz /products/email-lanes/ and the PDF audit). Every
// subject line is verbatim from the code that sends it. Where copy lives in
// the Paraform UI rather than in our repos, the subject says so rather than
// guessing.
//
// `schedule` drives the timing chart:
//   every  {n, offset}   every n minutes, starting at `offset` past the hour
//   marks  {minutes:[]}  explicit minutes past the hour
//   hourly {minute}      once an hour
//   daily  {times:[]}    wall-clock times in `tz`
//   event                fires on an external event, no clock
//   none                 nothing fires it today

export const MAILBOXES = [
  {
    id: "david",
    address: "david@raydar.xyz",
    role: "The contended mailbox",
    detail:
      "Shared by every sending lane, every reader robot, an Apps Script running inside the account, and Fyxer's OAuth grant. One bucket, and Google will not raise it.",
    limits: ["2,000 sends/day", "15,000 quota units/min", "2,500 MB read/day"],
    tone: "hot",
    healthId: "email-inbox-david",
  },
  {
    id: "calls",
    address: "calls@raydar.xyz",
    role: "Scheduler sender",
    detail:
      "A separate Gmail bucket. It sent about 233 messages straight through the 37-hour lockout. Nothing reads this mailbox, so a candidate who replies to it directly is read by nobody.",
    limits: ["Separate 2,000/day bucket", "No inbound reader"],
    tone: "ok",
    healthId: "email-scheduler-sender",
  },
  {
    id: "paraform-fleet",
    address: "Paraform sending fleet",
    role: "31 connected accounts",
    detail:
      "Thirty cold-outreach aliases across ten Raydar domains, plus david@raydar.xyz itself as the applicant and no-match sender. Paraform sends; we only enroll.",
    limits: ["31 accounts", "david@ is one of them"],
    tone: "warn",
    healthId: "email-paraform-mailboxes",
  },
  {
    id: "olivia",
    address: "olivia@raydar.xyz",
    role: "Built, not running",
    detail: "Olivia holds a real send path on her own mailbox. She has never sent in production.",
    limits: ["Zero sent to date"],
    tone: "muted",
    healthId: null,
  },
];

// The read side. These send nothing, and they are what actually exhausted the
// mailbox: roughly twenty reads per send. Costs are Gmail's published quota
// units per call, which were re-priced upward in May 2026.
export const READERS = [
  {
    "id": "booking-resume-sync",
    "name": "Booking resume sync",
    "mailbox": "david",
    "cadence": "Every 5 minutes at :03 past",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 3,
      "tz": "UTC"
    },
    "healthId": "lane-booking-resume-sync",
    "note": "Reads Paraform 'Meeting scheduled' mail. Was the single heaviest lane at ~992,000 units/day before its cache shipped.",
    "fixed": true
  },
  {
    "id": "booking-resume-retry",
    "name": "Booking resume retry",
    "mailbox": "david",
    "cadence": "Every 15 minutes at :06 past",
    "schedule": {
      "kind": "every",
      "n": 15,
      "offset": 6,
      "tz": "UTC"
    },
    "healthId": "lane-booking-resume-retry",
    "note": "The lane that was missed on the first recovery attempt, which is why that attempt failed."
  },
  {
    "id": "booking-email-index",
    "name": "Booking resume email index",
    "mailbox": "david",
    "cadence": "Daily",
    "schedule": {
      "kind": "daily",
      "times": [
        "04:00"
      ],
      "tz": "UTC"
    },
    "healthId": "lane-booking-resume-email-index",
    "note": "Rebuilds the message index once a day."
  },
  {
    "id": "paraai-reply-rescan",
    "name": "Para AI reply rescan",
    "mailbox": "david",
    "cadence": "With every worker pass, every 5 min at :04 past",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 4,
      "tz": "UTC"
    },
    "healthId": "paraai-lane",
    "note": "Re-opened every outreach thread every 45 seconds before the fix. Reply detection is the second-largest read cost."
  },
  {
    "id": "tn-reenable",
    "name": "Talent Network re-enable",
    "mailbox": "david",
    "cadence": "Daily at 09:20",
    "schedule": {
      "kind": "daily",
      "times": [
        "09:20"
      ],
      "tz": "local"
    },
    "healthId": "lane-tn-reenable",
    "note": "Read-only by design: it holds a scope that physically cannot send."
  },
  {
    "id": "n8n-paraform-notify",
    "name": "Paraform notify",
    "mailbox": "david",
    "cadence": "Every 10 min at :05 past, 06:00-21:00 PT weekdays",
    "schedule": {
      "kind": "every",
      "n": 10,
      "offset": 5,
      "tz": "PT"
    },
    "healthId": "n8n-workflows",
    "note": "Turns Paraform notification mail into Slack actions. The source of the prefilled candidate emails."
  },
  {
    "id": "n8n-booking-evidence",
    "name": "Booking evidence",
    "mailbox": "david",
    "cadence": "Per lifecycle evaluation",
    "schedule": {
      "kind": "event"
    },
    "healthId": "n8n-workflows",
    "note": "An on-demand Gmail oracle the lifecycle engine consults for booking proof."
  },
  {
    "id": "submission-notify",
    "name": "Submission responses",
    "mailbox": "david",
    "cadence": "Hourly at :20",
    "schedule": {
      "kind": "hourly",
      "minute": 20,
      "tz": "UTC"
    },
    "healthId": null,
    "note": "New Paraform request replies into Slack."
  },
  {
    "id": "resume-feed",
    "name": "Resume feed",
    "mailbox": "other",
    "cadence": "Every 15 minutes",
    "schedule": {
      "kind": "every",
      "n": 15,
      "offset": 0,
      "tz": "UTC"
    },
    "healthId": "lane-resume-feed",
    "note": "Reads resume@metawork.us, a different mailbox on a different credential. Sailed through the lockout untouched, which is the proof that separating mailboxes works.",
    "fixed": true
  },
  {
    "id": "archive-backfill",
    "name": "Archive backfill",
    "mailbox": "other",
    "cadence": "Every 30 minutes at :05 past",
    "schedule": {
      "kind": "every",
      "n": 30,
      "offset": 5,
      "tz": "UTC"
    },
    "healthId": "lane-archive-backfill",
    "note": "Backfills the resume mailbox archive."
  },
  {
    "id": "applicant-hub-worker",
    "name": "Applicant hub worker",
    "mailbox": "other",
    "cadence": "Always on",
    "schedule": {
      "kind": "event"
    },
    "healthId": "lane-applicant-hub-worker",
    "note": "Consumes the resume corpus through its own write-ahead log."
  }
];

export const QUOTA_COSTS = [
  { call: "Open a thread, full", units: 40, hot: true },
  { call: "Fetch a message", units: 20, note: "metadata costs the same as full" },
  { call: "Search", units: 5 },
  { call: "Ask what changed", units: 2, good: true, note: "the cheap answer almost nothing uses yet" },
  { call: "Send a message", units: 100, note: "a few hundred a day, irrelevant" },
  { call: "Write to Sent without sending", units: 25, note: "does not touch the daily send cap" },
];

export const GROUPS = [
  { id: "sa",        label: "Sends as you, through the robot", blurb: "A service account signs in as you on the Gmail API. These share the one contended bucket and stop when it locks." },
  { id: "mailbox",   label: "Sends from inside your mailbox",  blurb: "Not the service account. These run as you, in your account, and spend the same budget while being largely invisible to monitoring." },
  { id: "paraform",  label: "Paraform sends as you",           blurb: "Delivered by Paraform from your connected account. Never touches your Gmail sending cap, but carries your name and your domain reputation." },
  { id: "scheduler", label: "Scheduler and calendar mail",     blurb: "Sends as calls@raydar.xyz or as the calendar organiser. Separate quota, and it ran normally through both outages." },
  { id: "external",  label: "Never touches your mailbox",      blurb: "Candidate mail that carries a different identity entirely." },
];

export const LANES =
[
  {
    "id": "screener-opt-out",
    "group": "sa",
    "mailbox": "david",
    "healthId": "email-human-handoff",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 1,
      "tz": "UTC"
    },
    "name": "Screener opt-out intro link",
    "system": "Screener human handoff",
    "summary": "When a candidate tells the AI screener they would rather speak to a person, this emails them once, as David, with the intro-call booking link. It is the only email the lane sends; every other outcome posts to Slack instead.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "The screener call is scored as a human-call request, 5 minutes after the call ends.",
    "cadence": "Every 5 minutes, at :01 past the hour. One email per call, ever.",
    "runsOn": "Vercel cron",
    "volume": "9 delivered on 10 August, the busiest day on record",
    "rateLimit": "A rate limit holds the email, retries every 5 minutes, alerts David after 3 tries.",
    "stops": [
      "One send per call, tracked permanently",
      "30-day cooloff per email address",
      "Another upcoming or live call parks it"
    ],
    "gotchas": [
      "The duplicate-send guard never actually matches, so exactly-once rests on one saved row. Lost state can double-email a candidate.",
      "A stale deploy from another workspace deletes this lane's schedule. It happened four times; one candidate waited 84 minutes."
    ],
    "flow": [
      "Candidate asks for a human",
      "Q: Request confirmed?",
      "Find email address",
      "Q: Already emailed?",
      "Send intro link",
      "Log send permanently"
    ],
    "messages": [
      {
        "step": "Step 1 · only message",
        "subject": "Grab time with the Raydar team | AI Agent Optout",
        "gist": "Four short lines and one link: \"Totally understand wanting to chat with a real person instead of our AI agent.\" Signs off \"Best, David\" over his signature.",
        "delay": "About 6 to 11 minutes after the call"
      }
    ],
    "status": "live",
    "ifDown": "Down usually means the lifecycle cron is failing, or a stale deploy from another workspace unscheduled it (this has happened four times). A candidate who asked for a human is waiting, so treat it as urgent; a lone 429 shows degraded and clears itself.",
    "upgrade": true
  },
  {
    "id": "connector-ongoing",
    "group": "sa",
    "mailbox": "david",
    "healthId": "email-connector-chase",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 2,
      "tz": "UTC",
      "window": "9am-6pm PT, weekdays"
    },
    "name": "Connector chase, ongoing ladder",
    "system": "Connector referral follow-ups",
    "summary": "Chases Paraform connector referrals who never booked a call, replying on the original referral thread with three nudges; any reply from them resets the ladder. Since 2026-08-18 every thread takes this route, and the old backfill branch is retired.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A Paraform referral thread under 7 days old, with the welcome email sent and no call booked.",
    "cadence": "Every 5 minutes at :02 past, weekdays only. Send window is 9am to 6pm PT, and live hours are set elsewhere.",
    "runsOn": "Vercel cron",
    "volume": "Peaks at 147 emails a day, about 140 a day steady state",
    "rateLimit": "A rate limit stops the whole lane for 20 minutes, or until Google's stated time. Never retried.",
    "stops": [
      "A booked call, proven by the roster",
      "Any reply: opt-out stops, a question parks it",
      "Six lifetime emails, or 30 days from referral"
    ],
    "gotchas": [
      "A saved send is only a claim, written before the mail leaves. The mailbox is the only proof a candidate was actually emailed.",
      "First names alone are often all it knows, so the booked-call check over-blocks: 77 of 185 connector no-shows were silenced in one day."
    ],
    "flow": [
      "Referral lands in the inbox",
      "Welcome email goes out",
      "Q: Thread under 7 days old?",
      "Q: Booked, replied or bounced?",
      "Send nudge at D+2",
      "Send nudge at D+6",
      "Send final nudge at D+13",
      "Ladder ends, thread closed"
    ],
    "messages": [
      {
        "step": "Step 1 · D+2",
        "subject": "Re: {referrer} referred you to Paraform - Next Steps",
        "gist": "\"Hope you are doing well!\" then \"Just following up on my note above. Happy to find 15 minutes whenever suits you\" plus the link. A no-show variant exists.",
        "delay": "2 days after the last message on the thread"
      },
      {
        "step": "Step 2 · D+6",
        "subject": "Re: {referrer} referred you to Paraform - Next Steps",
        "gist": "Three lines and, uniquely, no booking link: \"Checking back in on this one. If you are still interested, grabbing 15 minutes is the quickest way to get moving.\"",
        "delay": "4 days after step 1"
      },
      {
        "step": "Step 3 · D+13",
        "subject": "Re: {referrer} referred you to Paraform - Next Steps",
        "gist": "\"Last one from me on this. I do not want to clutter your inbox.\" Offers to close it out, or book, with the link. The thread then ends.",
        "delay": "7 days after step 2"
      }
    ],
    "status": "live",
    "ifDown": "Degraded is almost always the persisted Gmail backoff clearing itself. Down means six straight failures or no successful run for three hours; check the david@ mailbox card first, since a locked mailbox surfaces here."
  },
  {
    "id": "connector-backfill",
    "group": "sa",
    "mailbox": "david",
    "healthId": "email-connector-chase",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 2,
      "tz": "UTC",
      "window": "9am-6pm PT, weekdays"
    },
    "name": "Connector chase, cold backfill",
    "system": "Connector referral follow-ups",
    "summary": "A two-email drain for the 825 connector referrals that had gone cold before this lane existed, sent as replies on the original referral thread. Two emails and the thread is finished; it never joins the ongoing ladder.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A Paraform referral thread older than 7 days when first seen, with no call booked.",
    "cadence": "Every 5 minutes at :02 past, weekdays only, same PT send window. The first email is due at once.",
    "runsOn": "Vercel cron",
    "volume": "825 cold referrals; 519 queued at arming, paced at 15 per run",
    "rateLimit": "A rate limit stops the whole lane for 20 minutes, or until Google's stated time. Never retried.",
    "stops": [
      "Both emails sent, thread never laddered",
      "A booked call, proven by the roster",
      "Any reply: opt-out stops, a question parks it"
    ],
    "gotchas": [
      "The pacing deadline has passed, so pacing is off: every due thread can go out in a single run. Nothing throttles the wave now.",
      "If the saved record ever read as empty, 800+ people would be chased again, so the lane refuses to run on an unreadable one."
    ],
    "flow": [
      "Old referral thread found",
      "Q: Older than 7 days?",
      "Marked as cold backfill",
      "Q: Booked, replied or bounced?",
      "First email goes at once",
      "Second email 4 days later",
      "Thread done, never laddered"
    ],
    "messages": [
      {
        "step": "Step 1 · immediate",
        "subject": "Re: {referrer} referred you to Paraform - Next Steps",
        "gist": "\"Circling back on this one. We never got a time on the calendar and I did not want to leave it sitting there.\" Then the link. A no-show variant exists.",
        "delay": "Due the moment the thread is found"
      },
      {
        "step": "Step 2 · +4 days",
        "subject": "Re: {referrer} referred you to Paraform - Next Steps",
        "gist": "\"Last nudge from me on this one. If the timing is not right, no problem at all and I will leave you to it.\" Then the link, and the thread is done.",
        "delay": "4 days after the first email"
      }
    ],
    "status": "deprecated",
    "ifDown": "Shares the ongoing ladder’s plumbing and tile, so whatever downs one downs both. Its pacing deadline has passed, so a stall followed by recovery can release every due thread in a single run.",
    "statusReason": "Retired 2026-08-18 on David’s order: the backfill did its job (the cold population is drained). Every thread now routes through the ongoing ladder, whose 30-days-from-referral stop retires anything ancient."
  },
  {
    "id": "interview-invites",
    "group": "sa",
    "mailbox": "david",
    "healthId": "lane-interview-invites",
    "schedule": {
      "kind": "hourly",
      "minute": 10,
      "tz": "local"
    },
    "name": "Interview invite ladder",
    "system": "Job Interview Agents",
    "summary": "A four step email ladder sent as David to applicants of his own job postings, walking them toward booking a role specific AI screening call. Every step is rechecked for a reply, a booked call or a protected recruiter just before it sends.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "Each cycle enrolls every eligible applicant of David's own postings: tier S, A or B, with an AI agent for the role.",
    "cadence": "Hourly at :10 local. One step per candidate per run, on day 0, day 3, day 7 and day 14 from the first email.",
    "runsOn": "Desktop launchd",
    "volume": "1,232 sent in 8 days; 341 on the busiest day; 480/day ceiling",
    "rateLimit": "A rate limit halts the whole run with no retry. The next hourly cycle picks it up.",
    "stops": [
      "Any reply on the thread stops it for good",
      "A booked or held call in the last 60 days stops it",
      "20 sends per cycle, then the run stops"
    ],
    "gotchas": [
      "What runs is a frozen copy on David's Mac, not the shared code, which still says three sends a day and a bigger budget.",
      "A copy edit does not reach a sender already running: on 8 August that sent 45 emails naming the client after the fix landed."
    ],
    "flow": [
      "Hourly check at :10",
      "Q: David's own posting?",
      "Q: Tier S, A or B?",
      "Q: Replied or call booked?",
      "Create the booking link",
      "Send day 0/3/7/14 step",
      "Q: Rate limited or capped?",
      "Books call, or day 14 ends"
    ],
    "messages": [
      {
        "step": "Step 1 · opener",
        "subject": "Raydar - 1st Round Interview - {jobTitle} 🎉",
        "gist": "Thanks for applying, bold job title plus a job description link, and \"we work on lots of roles across 1000's of companies\". Books a 10-15 minute agent call.",
        "delay": "Day 0, first cycle after enrollment"
      },
      {
        "step": "Step 2 · T+3d",
        "subject": "no subject, sent as a reply on the first email's thread",
        "gist": "\"Hope all is well!\" Notes no time is scheduled yet, asks if the role is still of interest, repeats the booking link. Signs off David, no signature.",
        "delay": "3 days after the first email"
      },
      {
        "step": "Step 3 · T+7d",
        "subject": "no subject, sent as a reply on the first email's thread",
        "gist": "\"Checking in again here.\" Offers a direct call with David if talking to the agent is a dealbreaker, and links his personal booking page.",
        "delay": "7 days after the first email, 4 after step 2"
      },
      {
        "step": "Step 4 · T+14d",
        "subject": "no subject, sent as a reply on the first email's thread",
        "gist": "\"Bumping this thread one last time.\" Stacks both links, agent call then a direct chat, and wishes them the best if they are no longer on the market.",
        "delay": "14 days after the first email, the last"
      }
    ],
    "status": "live",
    "ifDown": "A desktop lane: down usually means the Mac is asleep or launchd failed, so check the desktop-runner tile first. A Gmail 429 halts the whole run with no retry until the next hour, and what runs is a frozen copy on the Mac, not the repo.",
    "upgrade": true
  },
  {
    "id": "interview-fit",
    "group": "sa",
    "mailbox": "david",
    "healthId": "lane-interview-invites",
    "schedule": {
      "kind": "hourly",
      "minute": 10,
      "tz": "local"
    },
    "name": "Interview fit follow-up",
    "system": "Job Interview Agents",
    "summary": "After a candidate finishes an agent interview, one email replies on the same thread telling them whether they are a fit and linking their curated list of other roles. It is drafted, pinged to Slack for review, then released automatically.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A completed agent interview that the system can tie back to an invite, with a Paraform rating on the candidate.",
    "cadence": "90 minutes after the call ends, checked each hourly cycle. A call ending at or after 17:00 MT waits until 09:00 MT.",
    "runsOn": "Desktop launchd, same hourly cycle",
    "volume": "One email per completed interview. No cap and no pacing. Not measured.",
    "rateLimit": "A rate limit fails that one email and the cycle reports failure. No retry, no backoff here.",
    "stops": [
      "One email per interview, ever",
      "David already replying by hand cancels the draft",
      "Any missing fact parks the row for David"
    ],
    "gotchas": [
      "This lane names the client company in every version, which the invite emails never do. Reading the invite copy alone gets this wrong.",
      "It auto sends because a setting releases everything; the default is draft only, and this lane runs only from David's Mac."
    ],
    "flow": [
      "Agent interview call ends",
      "Q: Is this call ours?",
      "Q: 90 minutes elapsed?",
      "Fit score against 0.70",
      "Q: Curated matches found?",
      "Pick 1 of 4 templates",
      "Draft on the invite thread",
      "Auto send, Slack notified"
    ],
    "messages": [
      {
        "step": "Version 1 · fit, has matches",
        "subject": "Re: Raydar - 1st Round Interview - {jobTitle} 🎉",
        "gist": "\"I reviewed the screening call and can confirm you are a strong fit for the {jobTitle} at {company}.\" Sends the profile to the team, links their curated list.",
        "delay": "Call end + 90 minutes"
      },
      {
        "step": "Version 2 · fit, no matches",
        "subject": "Re: Raydar - 1st Round Interview - {jobTitle} 🎉",
        "gist": "Same as version 1, but instead of a list link it promises to share other relevant roles \"if they come my way!\"",
        "delay": "Same timing, only one version is sent"
      },
      {
        "step": "Version 3 · no fit, matches",
        "subject": "Re: Raydar - 1st Round Interview - {jobTitle} 🎉",
        "gist": "Reviewed the call for the {jobTitle} at {company}, then one honest sentence on why it is not moving forward, then the curated list of other matches.",
        "delay": "Same timing, only one version is sent"
      },
      {
        "step": "Version 4 · no fit, no matches",
        "subject": "Re: Raydar - 1st Round Interview - {jobTitle} 🎉",
        "gist": "Same no fit sentence, no list. Closes \"I have a good understanding of what you are looking for in your next role\" and promises to share matches later.",
        "delay": "Same timing, only one version is sent"
      }
    ],
    "status": "live",
    "ifDown": "Rides the interview-invites cycle and tile, so it goes down with the Mac. Its sends also stop silently when the call-evidence oracle cannot be read.",
    "upgrade": true
  },
  {
    "id": "resume-chase",
    "group": "sa",
    "mailbox": "david",
    "healthId": "lane-resume-chase",
    "schedule": {
      "kind": "marks",
      "minutes": [
        7,
        37
      ],
      "tz": "local"
    },
    "name": "Para AI resume chase",
    "system": "Para AI resume chase",
    "summary": "A three touch sequence asking a candidate for a current resume after a Para AI screening call leaves them without one. It also watches the mailbox for the reply attachment and files the resume to their Paraform profile, which ends the chase.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A completed Para AI call leaves the candidate flagged as waiting for a resume. Touch 1 is due 2 hours later.",
    "cadence": "Checked at :07 and :37 every hour. Touch 1 at 2 hours, touch 2 at 3 days, touch 3 at 7 days after the call.",
    "runsOn": "Desktop launchd",
    "volume": "6 emails ever, all touch 1, one per day; last one 6 August",
    "rateLimit": "Backs off 15, 30, 60 then 120 minutes; the 4th failure stops the lane until Gmail answers.",
    "stops": [
      "A resume arrives, gets filed, chase ends",
      "Any human reply, no show, or cancellation stops it",
      "Missing booking time or an internal address blocks it"
    ],
    "gotchas": [
      "It has never got past touch 1. Chains die first: 45 on identity review, 17 bad addresses, 11 replies, 11 expired windows.",
      "With nothing to send it still burns David's Gmail quota and shows red on health: it checks the mailbox for resumes every 6 hours."
    ],
    "flow": [
      "Call ends with no resume",
      "Checked at :07 and :37",
      "Q: Gmail backed off?",
      "Q: Guards and roster clear?",
      "Touch 1 at 2 hours",
      "Touch 2 at 3 days",
      "Touch 3 at 7 days, final",
      "Resume arrives, filed, stop"
    ],
    "messages": [
      {
        "step": "Touch 1 · the ask",
        "subject": "Resume for the roles we discussed",
        "gist": "\"A current resume is what lets me represent you accurately to teams - PDF is perfect.\" The bold line asks for the latest resume. Signs off with a signature.",
        "delay": "2 hours after the call ends"
      },
      {
        "step": "Touch 1 variant · never sent",
        "subject": "Your latest resume",
        "gist": "Used only for older backfilled candidates, and never sent. Claims no recent conversation and calls a resume \"the one thing I need to start putting you forward.\"",
        "delay": "2 hours after the backfill batch starts"
      },
      {
        "step": "Touch 2 · never sent",
        "subject": "Re: Resume for the roles we discussed (the stored subject \"Your latest resume\" is replaced on a reply)",
        "gist": "\"Quick nudge - still need your latest resume to get you in front of the right companies.\" Asks for even a rough version today. No signature on a reply.",
        "delay": "3 days after touch 1 lands"
      },
      {
        "step": "Touch 3 · never sent",
        "subject": "Re: Resume for the roles we discussed (the stored subject \"Your latest resume\" is replaced on a reply)",
        "gist": "\"Last nudge from me.\" Without a current resume he cannot submit them, and asks for a yes or no either way. Delivery closes the chase as complete.",
        "delay": "7 days after the call, or 4 after touch 2"
      }
    ],
    "status": "deprecated",
    "ifDown": "Its Gmail cooldown circuit exits clean while a banked 429 window is open, so a healthy beat with zero sends can hide the backoff for up to three straight failures; the fourth exhausts the circuit and the run exits with a failure beat, turning the tile red with the Mac awake — its usual red state. Otherwise a hard down means the Mac is asleep or the run crashed.",
    "statusReason": "Retired 2026-08-18 on David’s order: every booking now requires a resume up front (book.raydar.xyz) or arrives via Workable, so there is nothing left to chase. The desktop job is unloaded and its state archived."
  },
  {
    "id": "paraai-first-request",
    "group": "sa",
    "mailbox": "david",
    "healthId": "email-paraai-outreach",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 4,
      "tz": "UTC"
    },
    "name": "First interview request sequence",
    "system": "Para AI interview request outreach",
    "summary": "When a hiring manager files a candidate's first Paraform interview request, this emails them as David asking if they want to meet the team, then chases twice at two-day intervals. It opens the three-touch cadence.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A candidate's first Paraform interview request sits at pending status when the worker checks.",
    "cadence": "T+0, then T+2 days and T+4 days. Each chase is two days after the previous send.",
    "runsOn": "Vercel cron plus a Fly worker",
    "volume": "No daily cap. Max 3 emails per check, shared with follow-ups.",
    "rateLimit": "A rate limit on a Gmail read stands the whole lane down 20 to 23 minutes. Nothing is lost.",
    "stops": [
      "Any candidate reply, including an auto-reply",
      "Permanent bounce, off-market, or do-not-contact hold",
      "Request leaves pending or hits its 7-day expiry"
    ],
    "gotchas": [
      "If the signature lookup fails, the first email goes out signed \"Thanks,\" with no name at all. Later emails keep David's name.",
      "It replies on an old thread only when it finds that candidate's digest link in the first message it sent. Otherwise it starts fresh."
    ],
    "flow": [
      "First request goes pending",
      "Q: Rate limit stand-down?",
      "Find email and digest link",
      "Q: Bounced or off-market?",
      "Send email as David",
      "Q: Candidate replied?",
      "Chase at T+2 days",
      "Chase again at T+4 days"
    ],
    "messages": [
      {
        "step": "Step 1 · T+0",
        "subject": "1st Round - Interview Request @ {Company} 🎉",
        "gist": "Asks if they are interested in the {Role} @ {Company}: \"I shared a redacted version of your resume with the Founder.\" Links \"{First}'s Interview Requests\".",
        "delay": "0, on the check that picks it up"
      },
      {
        "step": "Step 2 · T+2d",
        "subject": "Re: 1st Round - Interview Request @ {Company} 🎉",
        "gist": "Follows up on the {Role} @ {Company} request: \"Let me know if you'd be open to connecting with the team!\" Signs off \"Thanks, David\".",
        "delay": "2 days after step 1 was sent"
      },
      {
        "step": "Step 3 · T+4d",
        "subject": "Re: 1st Round - Interview Request @ {Company} 🎉",
        "gist": "\"Any interest in exploring the {Role} @ {Company}?\" then \"If not, no worries! It would still be helpful to know if this one misses the mark.\"",
        "delay": "2 days after step 2 was sent"
      }
    ],
    "status": "live",
    "ifDown": "Degraded means the fleet Gmail breaker observed a 429 minutes ago (sends queue and resume on their own), or outreach is approved but not execution-ready. This tile never shows down: a dead Fly worker surfaces as a growing due queue on the Para AI automation tile and on the Fly worker tile.",
    "upgrade": true
  },
  {
    "id": "paraai-additional-request",
    "group": "sa",
    "mailbox": "david",
    "healthId": "email-paraai-outreach",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 4,
      "tz": "UTC"
    },
    "name": "Additional interview request sequence",
    "system": "Para AI interview request outreach",
    "summary": "When a candidate who already had an interview request gets another one, this emails them the new request on their existing thread and chases once two days later. It is the repeat-request half of the same outreach lane.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A candidate's second or later Paraform request is filed, counted across their whole request history.",
    "cadence": "Send on the check that admits it, then exactly one chase two days later. A newer request replaces that chase.",
    "runsOn": "Vercel cron plus a Fly worker",
    "volume": "No daily cap. Shares the 3-emails-per-check pool with first requests.",
    "rateLimit": "A rate limit on a Gmail read stands the whole lane down 20 to 23 minutes. Nothing is lost.",
    "stops": [
      "A past reply blocks the chase, not the new email",
      "Off-market or do-not-contact hold blocks the email",
      "A decline for that one role, or a bounce"
    ],
    "gotchas": [
      "David's signature is attached only when the email starts a new conversation, never on a reply. The rule is per thread.",
      "A reply no longer stops future sends: a model reads it, and only an off-the-market statement or an explicit stop request blocks them."
    ],
    "flow": [
      "Repeat request admitted",
      "Count requests in history",
      "Add role to their digest",
      "Q: Existing thread found?",
      "Reply on it, else new email",
      "Q: Replied to us before?",
      "Arm exactly one chase",
      "Send chase at T+2 days"
    ],
    "messages": [
      {
        "step": "Step 1 · T+0",
        "subject": "Re: {existing thread subject}, or when no thread exists: 1st Round - Interview Request @ {Company} 🎉",
        "gist": "\"You just got a new interview request for the {Role} @ {Company}\" plus \"The founders think you would be a very strong match!\" Third request on, wording rotates.",
        "delay": "0, on the check that picks it up"
      },
      {
        "step": "Step 2 · T+2d",
        "subject": "Re: {thread subject}",
        "gist": "One of three follow-up wordings, such as \"Just following up on the {Role} @ {Company} interview request.\" Closes \"Thanks, David\".",
        "delay": "2 days after the first email"
      }
    ],
    "status": "live",
    "ifDown": "Shares the outreach worker and tile: degraded is the breaker self-healing, or outreach approved but not execution-ready. The tile never shows down; a dead worker surfaces as a growing due queue on the Para AI automation tile and on the Fly worker tile.",
    "upgrade": true
  },
  {
    "id": "curated-interest",
    "group": "sa",
    "mailbox": "david",
    "healthId": null,
    "schedule": {
      "kind": "marks",
      "minutes": [
        0,
        15,
        30,
        45
      ],
      "tz": "UTC"
    },
    "name": "Curated list interest confirmation",
    "system": "Para AI curated list interest",
    "summary": "When a candidate marks interest in a role from a curated list, this pauses the sequence that sent the list and emails them once, as David, promising to get them in front of the team. Built and copy-approved, never sent.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A curated-list role flips to interested between two checks, and the pause on their sequences lands.",
    "cadence": "One email per interest batch. Sweep runs every 15 minutes, or every 60 seconds until a pass completes.",
    "runsOn": "Vercel cron plus a Fly worker",
    "volume": "Zero sent. 712 of 14,845 candidates eligible; 100 checked per sweep.",
    "rateLimit": "No stand-down of its own. A rate limit shows up as a delivery error on that one email.",
    "stops": [
      "No role clears pre-flight, so nothing is promised",
      "Paraform already confirms it, so we stay quiet",
      "No usable first name or deliverable address"
    ],
    "gotchas": [
      "As built, the message goes out with empty sender, recipient and subject fields, so Gmail cannot deliver it. Arming it yields errors.",
      "The email promises to get them in front of the team, but nothing automatic submits anyone. David does that by hand."
    ],
    "flow": [
      "Sweep curated-list recipients",
      "Q: Role moved to interested?",
      "Pause their list sequences",
      "Q: Pause confirmed on re-read?",
      "Check each interested role",
      "Q: Any role clears checks?",
      "Send one email as David",
      "David submits by hand"
    ],
    "messages": [
      {
        "step": "Step 1 · only message",
        "subject": "Your roles",
        "gist": "David's own words, unedited: \"I just saw that you signaled interest on the {role|roles} I sent over!\" Then \"Will get you in front of the {team|teams} asap.\"",
        "delay": "Same pass, after the roles are checked"
      }
    ],
    "status": "dark",
    "ifDown": "Never armed, so nothing can be down. Before arming it: the mailer as coded builds a malformed message Gmail cannot deliver, and that must be fixed first.",
    "statusReason": "Arming in progress (2026-08-18): the mailer bug is fixed and the canary path sends the next real interest event to David’s own inbox only. Candidate-facing sends additionally require arming the submission handoff, which is David’s call after the canary.",
    "upgrade": true
  },
  {
    "id": "applicant-ladder",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "daily",
      "times": [
        "09:00"
      ],
      "tz": "PT"
    },
    "name": "Applicant 1st round ladder",
    "system": "Sequences Launcher",
    "summary": "Nudges job applicants to book a first-round screening call. An operator uploads applicant spreadsheets, the launcher builds one sequence per job title, and Paraform sends every email from David's own mailbox.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate, job applicant",
    "trigger": "An operator uploads up to 15 applicant files on the Sequences page and presses Go.",
    "cadence": "Enrollment is manual. Delayed cohorts of 3, 7 or 14 days release daily at 9am PT. Send pace is Paraform's.",
    "runsOn": "Vercel cron plus Paraform platform",
    "volume": "910 first-step emails on one cohort, draining at about 98 a day",
    "rateLimit": "Paraform sends, so nothing retries here. A failure shows as an error and health drops.",
    "stops": [
      "Candidate replies, Paraform stops the sequence",
      "Candidate books a call, paused within a minute",
      "Already booked, enrolled, or a protected recruiter's role"
    ],
    "gotchas": [
      "No stage filter: one cohort emailed 910 applicants, about 96% never picked by a human, and none of the 45 shortlisted booked a call.",
      "The Send as David or Noah dropdown does not change who sends. It only labels a delay folder; the sequence's own account sends."
    ],
    "flow": [
      "Operator uploads applicants",
      "Grouped by job title",
      "Q: Role sequence exists?",
      "Copy template, insert role",
      "Q: Booked or protected?",
      "Enroll now or park for later",
      "Paraform sends as David",
      "Booking or reply pauses lead"
    ],
    "messages": [
      {
        "step": "Step 1",
        "subject": "Raydar | 1st Round Interview 🎉",
        "gist": "Invites the applicant to book: \"Interested? Grab a time here:\" plus a link, and a P.S. offering a phone call instead. Ends \"Excited for next steps here!\"",
        "delay": "Sent when Paraform next picks up the lead"
      },
      {
        "step": "Steps 2+",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. Step count and copy are written and stored in the Paraform UI; the launcher only swaps the role name into whatever is there.",
        "delay": "not in code"
      }
    ],
    "status": "live",
    "ifDown": "The tile watches our enrollment and pause plumbing, not Paraform’s delivery. If david@’s account errors on Paraform’s side, the mailbox fleet card is built to go down on that gmail status error; the 2026-08-04 failure was caught by a per-sequence readback."
  },
  {
    "id": "agent-no-matches",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "hourly",
      "minute": 35,
      "tz": "UTC"
    },
    "name": "Agent no matches sequence",
    "system": "Para AI curated fit routing",
    "summary": "Tells a candidate whose screening call the agent ran that they were added to Para AI, though no roles landed on their curated list. Paraform sends it from David's own mailbox, not a service account.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate, agent-screened",
    "trigger": "A screening call run on the agent seat finishes, and 45 minutes later the curated list is empty.",
    "cadence": "Hourly at :35. One enrollment per candidate, ever. Paraform sends after; over 6 hours counts as stalled.",
    "runsOn": "GitHub Actions, then Paraform platform",
    "volume": "Capped at 25 per hour and 100 a day; 9 of 13 test candidates landed here",
    "rateLimit": "Paraform sends, so nothing retries here. A failure shows as an error and health drops.",
    "stops": [
      "A past reply blocks this candidate forever",
      "Any live or paused membership blocks re-enrollment",
      "Disabled or renamed target stops and alerts, never silent"
    ],
    "gotchas": [
      "Zero curated roles usually means the fits were rated only Maybe, not that none existed, so this is the biggest bucket, 9 of 13 in test.",
      "A different part of the system still expects this sequence's old name, so it silently cannot register these enrollments."
    ],
    "flow": [
      "Agent finishes screening call",
      "Wait 45 minutes",
      "Q: In Talent Network?",
      "Curate top-rated roles",
      "Q: Curated roles zero?",
      "Q: Already emailed or replied?",
      "Enroll in agent no-matches",
      "Paraform sends as David"
    ],
    "messages": [
      {
        "step": "Step 1",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. The one recorded line is the opener the split was built around: \"Thanks so much for taking the time to chat with our Raydar Agent!\"",
        "delay": "45 minutes after the call, then queued"
      },
      {
        "step": "Steps 2+",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. Step count and copy live in the Paraform UI. Our side only checks the sequence is on, sends all seven days, and has a live sender.",
        "delay": "not in code"
      }
    ],
    "status": "live",
    "ifDown": "Enrollment is a GitHub Actions tick at :35, so a red curated-fit routing run is the usual cause of a stall. Paraform sending afterwards is its own risk: more than 6 hours to first send counts as stalled."
  },
  {
    "id": "human-no-matches",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "hourly",
      "minute": 35,
      "tz": "UTC"
    },
    "name": "Human no matches sequence",
    "system": "Para AI curated fit routing",
    "summary": "The same zero-fit follow-up for a candidate screened by a human recruiter. It exists because the shared version thanked everyone for chatting with the Raydar Agent, which was false; Paraform sends it from David's mailbox.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate, human-screened",
    "trigger": "A screening call owned by a human recruiter finishes, and 45 minutes later the curated list is empty.",
    "cadence": "Hourly at :35. One enrollment per candidate, ever. Paraform sends after; over 6 hours counts as stalled.",
    "runsOn": "GitHub Actions, then Paraform platform",
    "volume": "Capped at 25 per hour and 100 a day; nearly every human call lands here",
    "rateLimit": "Paraform sends, so nothing retries here. A failure shows as an error and health drops.",
    "stops": [
      "A past reply blocks this candidate forever",
      "Any live or paused membership blocks re-enrollment",
      "Disabled or renamed target stops and alerts, never silent"
    ],
    "gotchas": [
      "Call type comes from whose calendar the call sat in, not the transcript. Typed wrong, a human candidate gets the agent's email.",
      "This sequence was switched off for its first two days, until 6 August, and a related system still cannot see it at all."
    ],
    "flow": [
      "Human recruiter runs the call",
      "Wait 45 minutes",
      "Q: In Talent Network?",
      "Park 60 min, submit, recheck",
      "Curate top-rated roles",
      "Q: Curated roles zero?",
      "Enroll in human no-matches",
      "Paraform sends as David"
    ],
    "messages": [
      {
        "step": "Step 1",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. The only recorded copy fact is negative: this version must not open \"Thanks so much for taking the time to chat with our Raydar Agent!\"",
        "delay": "45 minutes after the call, then queued"
      },
      {
        "step": "Steps 2+",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. Step count and copy live in the Paraform UI. Our side only checks the sequence is on, sends all seven days, and has a live sender.",
        "delay": "not in code"
      }
    ],
    "status": "live",
    "ifDown": "Same :35 Actions tick and the same failure shape as the agent lane: red Actions run first, then a Paraform first-send stall past 6 hours."
  },
  {
    "id": "agent-curated",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "hourly",
      "minute": 35,
      "tz": "UTC"
    },
    "name": "Agent curated list follow ups",
    "system": "Para AI curated fit routing",
    "summary": "After an AI agent screening call, if roles landed on the candidate's curated Para AI list, this enrolls them in one of two follow up sequences: one for a single role, one for two or more. Paraform sends the mail as David.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate",
    "trigger": "Curated roles land on an agent-screened candidate's list; the count picks the one-role or two-plus version.",
    "cadence": "Hourly at :35, plus a daily 13:50 backstop check. One enrollment per candidate, ever.",
    "runsOn": "GitHub Actions, sending inside Paraform",
    "volume": "Cap 25 per run, 100 per day. Lead counts 52 and 128 on 4 August.",
    "rateLimit": "Not applicable: we only enroll, Paraform sends. No Gmail retry path.",
    "stops": [
      "A reply anywhere in the family blocks forever",
      "Already in any of the eight sequences: no send",
      "Booking a call pauses the lead within 10 minutes"
    ],
    "gotchas": [
      "The sequence is picked from what actually landed on the list, so a rejected role quietly downgrades a two-plus candidate to one.",
      "Only these curated list sequences are protected by name when a candidate books, so the no-matches emails in the same lane are not."
    ],
    "flow": [
      "Agent screening call ends",
      "Count roles on curated list",
      "Q: One role or two plus?",
      "Pick the matching sequence",
      "Q: Replied or already in?",
      "Enroll and confirm",
      "Paraform sends as David",
      "Booking pauses the lead"
    ],
    "messages": [
      {
        "step": "Step 1",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code, lives in the Paraform UI. Nothing about this copy survives on our side, not even a fragment.",
        "delay": "Paraform sends step 1, stalled after 6h"
      },
      {
        "step": "Steps 2+",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. The number of steps, the subjects and the bodies all live in the Paraform UI.",
        "delay": "not in code"
      }
    ],
    "status": "live",
    "ifDown": "Same :35 Actions tick as the no-matches lanes. A switched-off sequence target hard-stops routing rather than silently mis-filing candidates."
  },
  {
    "id": "human-curated",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "hourly",
      "minute": 35,
      "tz": "UTC"
    },
    "name": "Human curated list follow ups",
    "system": "Para AI curated fit routing",
    "summary": "The same pair of follow ups after a human recruiter call: one sequence for a single curated role, one for two or more. The code will enroll a candidate today, but this half has never once fired.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate",
    "trigger": "Curated roles land on a candidate whose call was owned by a person, not the agent booking seat.",
    "cadence": "Hourly at :35, plus a daily 13:50 backstop check. One enrollment per candidate, ever.",
    "runsOn": "GitHub Actions, sending inside Paraform",
    "volume": "Cap 25 per run, 100 per day. No enrollment ever recorded.",
    "rateLimit": "Not applicable: we only enroll, Paraform sends. No Gmail retry path.",
    "stops": [
      "A reply anywhere in the family blocks forever",
      "Already in any of the eight sequences: no send",
      "Booking a call pauses the lead within 10 minutes"
    ],
    "gotchas": [
      "This is the least proven copy in the family. Treat the first live enrollment as an event worth checking, not routine.",
      "A human call mistaken for an agent call sends the agent copy, which thanks the candidate for chatting with the Raydar Agent."
    ],
    "flow": [
      "Human recruiter call ends",
      "Count roles on curated list",
      "Q: One role or two plus?",
      "Pick the matching sequence",
      "Q: Replied or already in?",
      "Enroll and confirm",
      "Paraform sends as David",
      "Flag it: branch unproven"
    ],
    "messages": [
      {
        "step": "Step 1",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code, lives in the Paraform UI. No copy, or even a fragment, exists on our side for either sequence.",
        "delay": "Paraform sends step 1, stalled after 6h"
      },
      {
        "step": "Steps 2+",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. The number of steps, the subjects and the bodies all live in the Paraform UI.",
        "delay": "not in code"
      }
    ],
    "status": "live",
    "ifDown": "Same :35 Actions tick as the no-matches lanes. A switched-off sequence target hard-stops routing rather than silently mis-filing candidates."
  },
  {
    "id": "retired-new-matches",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "none"
    },
    "name": "Retired new matches sequences",
    "system": "Para AI curated fit routing",
    "summary": "The two original post-call match emails, replaced by the curated fit sequences in August 2026. Nothing in our systems can enroll anyone into them any more, and nothing should still be sending them.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate",
    "trigger": "Nothing fires them. New enrollment is blocked, so only Paraform could advance an old member.",
    "cadence": "None. No enrollment cadence remains; leftover step timing sits in Paraform and is not in code.",
    "runsOn": "Nothing on our side; Paraform only",
    "volume": "not measured",
    "rateLimit": "Not applicable: nothing on our side sends, retries or backs off for these.",
    "stops": [
      "No new enrollment is possible at all",
      "Old membership still blocks curated re-enrollment",
      "A reply blocks every sequence in the family"
    ],
    "gotchas": [
      "Retired means retired for enrollment. At our only record the one-role sequence was switched off, so do not assume mail is going out.",
      "Three different names exist for these two sequences over time, so only the underlying records are safe to match on."
    ],
    "flow": [
      "Candidate enrolled pre August",
      "Sequence retired for new adds",
      "Q: Is it even switched on?",
      "Paraform owns any leftovers",
      "Old membership blocks re-adds",
      "Q: Replied anywhere?",
      "Reply blocks all future sends"
    ],
    "messages": [
      {
        "step": "All steps",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Not in code. No step copy survives on our side, only the names. The copy lives in the Paraform UI.",
        "delay": "not in code"
      }
    ],
    "status": "deprecated",
    "ifDown": "Nothing on our side runs it, so nothing can be down. A send could still be Paraform advancing a leftover pre-cutover member; verify in Paraform before treating a send as a bug.",
    "statusReason": "Retired: new enrollment is blocked in code, and only leftover Paraform members could still advance. Nothing on our side should ever send these again."
  },
  {
    "id": "no-show-followup",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "marks",
      "minutes": [
        3,
        15,
        33,
        45
      ],
      "tz": "UTC"
    },
    "name": "No show follow up sequence",
    "system": "Lifecycle Automation Engine",
    "summary": "When a screening call is confirmed a no show, this enrolls the candidate into the Paraform sequence No Show - Agent Call so Paraform sends the rebooking follow up. It replaces David spotting a red row and emailing by hand.",
    "sender": "Sender not in code · sent by Paraform",
    "recipient": "Candidate",
    "trigger": "The monitor marks the call a no show, backed by hard attendance proof, and still says so 30 minutes later.",
    "cadence": "Every 30 minutes at :03 and :33, plus a recovery pass at :15 and :45. First send 75 to 105 min after the call.",
    "runsOn": "Vercel cron, Paraform sends",
    "volume": "Not measured live. Caps at 10 confirmations a cycle; 191 in a backfill.",
    "rateLimit": "No Gmail path: Paraform sends. An expired Paraform login idles the lane and alerts David.",
    "stops": [
      "Any reply stops the sequence, handled by Paraform",
      "A rebooking pauses it within 30 minutes",
      "Verdict flips back to success: sequence auto-paused"
    ],
    "gotchas": [
      "A recent successful call or any scheduled call blocks enrollment outright: nobody who already spoke to us or has a booking gets chased.",
      "The original invite must read unchanged twice, 30 minutes apart, before any send. Rescheduled bookings are skipped, correctly."
    ],
    "flow": [
      "Monitor flags a no show",
      "Q: Still a no show 30m on?",
      "Q: Attendance proof found?",
      "Match the exact candidate",
      "Q: Invite unchanged twice?",
      "Q: Call held or scheduled?",
      "Enroll in No Show sequence",
      "Pause if they rebook"
    ],
    "messages": [
      {
        "step": "Step 1 · plan Day 0",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Live copy is not on our side. The draft plan sends a \"Sorry we missed you today\" note with a booking link.",
        "delay": "Day 0 in the plan; live delay not in code"
      },
      {
        "step": "Step 2 · plan +2 days",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Live copy is not on our side. The draft is a short nudge, \"Still keen to chat\", repeating the booking link.",
        "delay": "Plan: 2 days after step 1; not in code"
      },
      {
        "step": "Step 3 · plan +5 days",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Live copy is not on our side. The draft closes the loop: \"the door's open\", with the booking link one last time.",
        "delay": "Plan: 5 days after enrollment; not in code"
      }
    ],
    "status": "live",
    "ifDown": "A Vercel cron on the lifecycle project. The historical cause of silent stops is a stale-tree deploy unscheduling the sibling crons; a dedicated :15/:45 recovery drain with reserved slots keeps the backlog from starving fresh calls."
  },
  {
    "id": "audio-fail-followup",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "marks",
      "minutes": [
        3,
        33
      ],
      "tz": "UTC"
    },
    "name": "Audio failure follow up sequence",
    "system": "Lifecycle Automation Engine",
    "summary": "A call that fails on our side enrolls the candidate into the Paraform sequence Audio Failed - Agent Call. The copy owns the failure as ours and never implies the candidate missed the call.",
    "sender": "Sender not in code · sent by Paraform",
    "recipient": "Candidate",
    "trigger": "The monitor files the call under errors and failures, and the same verdict is still there 30 minutes later.",
    "cadence": "Every 30 minutes at :03 and :33. First send about 75 to 105 minutes after the call. No recovery pass.",
    "runsOn": "Vercel cron, Paraform sends",
    "volume": "Not measured. Capped at 10 confirmations per 30 minute cycle.",
    "rateLimit": "No Gmail path: Paraform sends. An expired Paraform login idles the lane and alerts David.",
    "stops": [
      "Any reply stops the sequence, handled by Paraform",
      "A rebooking pauses it within 30 minutes",
      "One follow up per candidate per 14 days"
    ],
    "gotchas": [
      "A recent successful call or a scheduled call still blocks enrollment, and the candidate's own failed slot cannot vouch for itself.",
      "A misread upstream turns good calls into failures: on 4 August candidates with full recordings were enrolled, no human in the loop."
    ],
    "flow": [
      "Monitor flags a failed call",
      "Q: Same verdict 30m later?",
      "Match the exact candidate",
      "Q: Role or archive tag set?",
      "Q: Call held or scheduled?",
      "Enroll in Audio Failed",
      "Verify the lead and its email",
      "Pause if they rebook"
    ],
    "messages": [
      {
        "step": "Step 1 · plan Day 0",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Live copy is not on our side. The draft owns it: \"we hit an audio issue on our end and couldn't hear you properly. That's on us.\" Plus a link.",
        "delay": "Day 0 in the plan; live delay not in code"
      },
      {
        "step": "Step 2 · plan +2 days",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Live copy is not on our side. The draft nudges once, \"Making it right\", saying the issue is fixed and asking for a redo.",
        "delay": "Plan: 2 days after step 1; not in code"
      },
      {
        "step": "Step 3 · plan +5 days",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Live copy is not on our side. The draft asks \"One more try?\" and says we would really like to complete the screening.",
        "delay": "Plan: 5 days after step 1; not in code"
      }
    ],
    "status": "live",
    "ifDown": "Same lifecycle cron family as the no-show lane, but with no recovery drain: a missed window stays missed until the next :03/:33 tick."
  },
  {
    "id": "curated-fit-routing",
    "group": "paraform",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-sequences",
    "schedule": {
      "kind": "hourly",
      "minute": 35,
      "tz": "UTC"
    },
    "name": "Curated fit routing, six sequences",
    "system": "Para AI curated fit routing",
    "summary": "After every completed screening call, this curates the candidate's Paraform role matches and enrolls them into exactly one of six follow up sequences, chosen by how many roles survived, 0, 1 or 2 plus, and by who ran the call.",
    "sender": "david@raydar.xyz · sent by Paraform",
    "recipient": "Candidate",
    "trigger": "A screening call completes with proof of success, at least 45 minutes old, and the person is in the Talent Network.",
    "cadence": "Hourly at :35 UTC, plus a daily health check at 13:50. Up to 25 candidates a tick, 100 a day.",
    "runsOn": "GitHub Actions, Paraform sends",
    "volume": "315 candidates routed 4 to 17 August; 536 skipped, 141 failed.",
    "rateLimit": "No Gmail path: Paraform sends on its own windows. First send can take over 3 hours.",
    "stops": [
      "Any reply stops the sequence, handled by Paraform",
      "Already in a curated list sequence: skipped",
      "Applied or replied since the call: suppressed"
    ],
    "gotchas": [
      "A human call counts as successful only if the quieter voice said 300 characters or more, which catches an automated receptionist.",
      "Whose calendar the call came from decides agent or human, not the words: reading the transcript misread 2 of Alzen's 5 calls as agent."
    ],
    "flow": [
      "Hourly tick at :35",
      "Q: Did the call succeed?",
      "Q: Agent or human, by owner?",
      "Q: In the Talent Network?",
      "Curate the role matches",
      "Q: Already replied or in flow?",
      "Route by count and call type",
      "Enroll, then verify first send"
    ],
    "messages": [
      {
        "step": "Route 1 · agent, 0 roles",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Sequence \"(Raydar Agent) No Matches - Added to Para AI\". Opens \"Thanks so much for taking the time to chat with our Raydar Agent!\" 173 routed, the biggest.",
        "delay": "Paraform setting; only step one observed"
      },
      {
        "step": "Route 2 · human, 0 roles",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Sequence \"(Human Call) No Matches - Added to Para AI\", built 4 August so nobody is thanked for chatting with an agent they never met. 48 routed.",
        "delay": "Paraform setting; only step one observed"
      },
      {
        "step": "Route 3 · agent, 1 role",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Sequence \"(1) Agent Call Follow Up - Curated List\", delivers the single surviving role. 24 routed. A switched off target now hard stops.",
        "delay": "Paraform setting; multi step, up to step 3"
      },
      {
        "step": "Route 4 · agent, 2+ roles",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Sequence \"(2+) Agent Call Follow Up - Curated List\", delivers the multi role curated list. 52 routed, the busiest curated list route.",
        "delay": "Paraform setting; multi step, up to step 3"
      },
      {
        "step": "Route 5 · human, 1 role",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Sequence \"(1) Human Call Follow Up - Curated List\". 7 routed, all complete, though it is still written up as an unused route.",
        "delay": "Paraform setting; only step one observed"
      },
      {
        "step": "Route 6 · human, 2+ roles",
        "subject": "not in code, lives in the Paraform UI",
        "gist": "Sequence \"(2+) Human Call Follow Up - Curated List\". 11 routed of 14 candidates carrying it. Also written up as unused; it has fired.",
        "delay": "Paraform setting; only step one observed"
      }
    ],
    "status": "live",
    "ifDown": "A red curated-fit routing run under GitHub Actions, or a stalled first-send verification. Skips are recorded durably, and 536 skipped against 315 routed in its first two weeks is normal shape, not failure."
  },
  {
    "id": "precall-reminder",
    "group": "scheduler",
    "mailbox": "calls",
    "healthId": "email-precall-reminders",
    "schedule": {
      "kind": "every",
      "n": 5,
      "offset": 0,
      "tz": "UTC"
    },
    "name": "Pre call reminder, one hour before",
    "system": "Pre-call reminder emails",
    "summary": "One short reminder to every candidate holding a booked Raydar call, about 60 minutes before it starts, aimed at a measured 39% no-show rate. It sends from calls@raydar.xyz, which nobody reads, so replies route to David.",
    "sender": "calls@raydar.xyz · service account, reply-to david@",
    "recipient": "Candidate",
    "trigger": "A confirmed booking starts in 10 to 60 minutes and was not booked inside the final hour.",
    "cadence": "Every 5 minutes, at :00, :05 and so on. One reminder per call, sent 55 to 60 minutes before the start.",
    "runsOn": "Vercel cron",
    "volume": "Capped at 25 per 5-minute run and 100 per day, actual volume not measured",
    "rateLimit": "No retry on the send. A rate limit burns that reminder for good and alerts a human.",
    "stops": [
      "Already sent, or the start is under 10 minutes away",
      "Booked inside the final hour, or replaced by a newer one",
      "Junk first name, such as test or there, parks it"
    ],
    "gotchas": [
      "Only one reminder exists, at 60 minutes out. The often-repeated 24 hour reminder does not exist.",
      "It sends as calls@ but reads David's calendar, so it stalled through the whole 8 to 9 August lockout even though calls@ was healthy."
    ],
    "flow": [
      "Cron tick every 5 minutes",
      "Read David's calendar",
      "Q: Call within 60 minutes?",
      "Q: Late, replaced, internal?",
      "Re-check: same start time?",
      "Write copy for the call type",
      "Send once as calls@",
      "Q: Send failed? No retry"
    ],
    "messages": [
      {
        "step": "Only message · video call",
        "subject": "Reminder: your Raydar call at {time} {tz}",
        "gist": "Six locked paragraphs: \"This is an automated reminder that your Raydar call is scheduled for {time} {tz}.\" plus \"Join here: {meetUrl}\" and a not-monitored footer.",
        "delay": "55 to 60 minutes before the call starts"
      },
      {
        "step": "Only message · phone call",
        "subject": "Reminder: your Raydar call at {time} {tz}",
        "gist": "Same six paragraphs with no link at all: \"Raydar will call the phone number you provided at that time.\" Sending a link on this leg is blocked outright.",
        "delay": "Same window, chosen by call type"
      }
    ],
    "status": "live",
    "ifDown": "Two-plus hours with no successful run shows degraded; down means the lane itself reports unhealthy. It sends as calls@ but reads David’s calendar, so a locked david@ mailbox stalls it — that stopped reminders for 31 hours in the 08-09 incident. A 429 burns that reminder for good."
  },
  {
    "id": "booking-confirm",
    "group": "scheduler",
    "mailbox": "calls",
    "healthId": "email-scheduler-sender",
    "schedule": {
      "kind": "every",
      "n": 2,
      "offset": 0,
      "tz": "UTC"
    },
    "name": "Scheduler booking confirmation",
    "system": "Raydar Scheduler",
    "summary": "The confirmation a candidate gets right after booking an Agent Call or Intro Call at book.raydar.xyz, carrying the time, the video link or the we-will-call-you line, and the manage link. It queues, then sends minutes later.",
    "sender": "calls@raydar.xyz · scheduler outbox",
    "recipient": "Candidate",
    "trigger": "A candidate confirms a booking on the live booking pages, and the calendar event and video link exist.",
    "cadence": "Once per booking. Held 60 seconds, then drained by a run every 2 minutes, so it lands 1 to 3 minutes later.",
    "runsOn": "Vercel cron",
    "volume": "About 233 a day across the whole scheduler outbox, no per-email split",
    "rateLimit": "A rate limit on the send parks the email for a human, never retried. Other faults retry.",
    "stops": [
      "Calendar event or video link not ready yet",
      "Booking cancelled or rescheduled while queued",
      "Approved public mailbox unset, parks it forever"
    ],
    "gotchas": [
      "No reply-to header, so a candidate who hits reply lands in calls@raydar.xyz, which nobody reads.",
      "If a safety switch is off, confirmations park silently forever and never surface as stuck jobs."
    ],
    "flow": [
      "Candidate books a call",
      "Queue email, hold 60 seconds",
      "Worker runs every 2 minutes",
      "Q: Safety switch armed?",
      "Q: Calendar and link ready?",
      "Check it was not sent before",
      "Send as calls@, no reply-to",
      "Q: Send failed? Park it"
    ],
    "messages": [
      {
        "step": "Only message · video call",
        "subject": "Your agent call with Raydar is booked",
        "gist": "\"You are booked for {Weekday, Month D, YYYY at H:MM AM TZ}.\" Then the Meet link, \"Google Calendar will send your invitation separately.\" and a manage link.",
        "delay": "1 to 3 minutes after booking"
      },
      {
        "step": "Only message · phone call",
        "subject": "Your intro call with Raydar is booked",
        "gist": "Same card, but the video line becomes \"A member of the Raydar team will call the number you provided.\" No button and no calendar file attached.",
        "delay": "Also waits for both calendar holds"
      }
    ],
    "status": "live",
    "ifDown": "Mirrors the scheduler’s own Gmail check. This bucket sailed through both mailbox lockouts, so red here means the scheduler deploy or the calls@ delegation, not Gmail-wide trouble."
  },
  {
    "id": "legacy-booking-confirm",
    "group": "sa",
    "mailbox": "david",
    "healthId": "email-scheduler-sender",
    "schedule": {
      "kind": "event"
    },
    "name": "Legacy booking confirmation",
    "system": "Raydar Scheduler",
    "summary": "The original scheduler confirmation, sent from David's own mailbox with a calendar file attached and a line naming him as the person the AI screener represents. It is the only scheduler email that can send as david@, and it is off.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "David's test address",
    "trigger": "A booking on the old event type, which only David's own approved test address can now create.",
    "cadence": "Once per booking, queued with no delay and drained by a run every 2 minutes. Expected volume is zero.",
    "runsOn": "Vercel cron",
    "volume": "Zero in normal operation, the old booking page redirects away",
    "rateLimit": "A rate limit on the send parks the email for a human, never retried. Other faults retry.",
    "stops": [
      "Old booking page redirects to the live one",
      "Only David's approved test address may book",
      "Calendar event or video link not ready"
    ],
    "gotchas": [
      "It is the one scheduler email that can send as david@, putting volume back on the quota the August outages exhausted.",
      "It is also the only Raydar email that attaches a calendar file; the live path leaves invitations to Google Calendar."
    ],
    "flow": [
      "Old booking page attempt",
      "Q: David's test address?",
      "Queue email, no delay",
      "Worker runs every 2 minutes",
      "Q: Calendar and link ready?",
      "Attach the calendar file",
      "Send as david@",
      "Q: Send failed? Park or retry"
    ],
    "messages": [
      {
        "step": "Only message",
        "subject": "Your intro call with Raydar is booked",
        "gist": "Like the live confirmation, but says \"A calendar file is attached.\" and adds \"You will be speaking with Raydar's AI screener on behalf of David Phillips.\"",
        "delay": "Sent on the next run, within 2 minutes"
      }
    ],
    "status": "dark",
    "ifDown": "Expected silent: its chip mirrors the scheduler sender. Any send appearing from this lane means the legacy fallback path re-activated, which is worth chasing.",
    "statusReason": "Dark and marked for removal (David, 2026-08-18). It can only mail the approved test address; deleting the code awaits a scheduler release, which is not worth doing for gated-off dead code alone."
  },
  {
    "id": "booking-cancel",
    "group": "scheduler",
    "mailbox": "calls",
    "healthId": "email-scheduler-sender",
    "schedule": {
      "kind": "every",
      "n": 2,
      "offset": 0,
      "tz": "UTC"
    },
    "name": "Booking cancellation email",
    "system": "Raydar Scheduler",
    "summary": "Confirms a cancellation the candidate made through the manage link, and points them back at the manage page. Google Calendar sends the matching event removal separately.",
    "sender": "calls@raydar.xyz · scheduler outbox",
    "recipient": "Candidate",
    "trigger": "The candidate cancels from the manage link on a booking made through the current booking pages.",
    "cadence": "Once per cancellation, queued immediately and sent on the next run, so within about 2 minutes.",
    "runsOn": "Vercel cron",
    "volume": "Counted inside about 233 a day for the scheduler outbox, no split",
    "rateLimit": "A rate limit on the send parks the email for a human, never retried. Other faults retry.",
    "stops": [
      "Booking made on the old event type gets no email",
      "Test bookings never mail a candidate",
      "Approved public mailbox unset, parks it forever"
    ],
    "gotchas": [
      "Bookings made on the old event type are silently skipped: cancelling one sends the candidate nothing at all.",
      "The subject capitalizes the call name while the confirmation lower-cases it, so the pair reads inconsistently."
    ],
    "flow": [
      "Candidate opens manage link",
      "Clicks cancel",
      "Q: Test booking? No email",
      "Queue calendar removal first",
      "Worker runs every 2 minutes",
      "Q: Current booking type?",
      "Send as calls@",
      "Q: Send failed? Park or retry"
    ],
    "messages": [
      {
        "step": "Only message",
        "subject": "Your Agent Call with Raydar is cancelled",
        "gist": "Says \"Your booking has been cancelled.\" then \"Google Calendar will send the matching event update separately.\" and the manage link. Headline: Booking cancelled.",
        "delay": "Within about 2 minutes of cancelling"
      }
    ],
    "status": "live",
    "ifDown": "Same outbox and tile as confirmations: red here means the scheduler’s sender is broken for confirmations, cancellations and reschedules alike."
  },
  {
    "id": "booking-reschedule",
    "group": "scheduler",
    "mailbox": "calls",
    "healthId": "email-scheduler-sender",
    "schedule": {
      "kind": "every",
      "n": 2,
      "offset": 0,
      "tz": "UTC"
    },
    "name": "Reschedule replaced time email",
    "system": "Raydar Scheduler",
    "summary": "When a candidate picks a different time, this tells them the previous slot was cancelled and replaced. A reschedule therefore sends two emails: this notice, then a fresh confirmation for the new time.",
    "sender": "calls@raydar.xyz · scheduler outbox",
    "recipient": "Candidate",
    "trigger": "The candidate rebooks a different time, so the new booking replaces an existing one.",
    "cadence": "Once per reschedule, queued immediately and sent on the next run, so within about 2 minutes.",
    "runsOn": "Vercel cron",
    "volume": "Counted inside about 233 a day for the scheduler outbox, no split",
    "rateLimit": "A rate limit on the send parks the email for a human, never retried. Other faults retry.",
    "stops": [
      "Old event type bookings get no email",
      "Repeat rebook of the same slot is a no-op",
      "Approved public mailbox unset, parks it forever"
    ],
    "gotchas": [
      "A reschedule sends two emails to the same candidate within about a minute, both from calls@ and both against its send budget.",
      "The manage link in this notice points at the old booking, not the new one."
    ],
    "flow": [
      "Candidate picks a new time",
      "New booking replaces the old",
      "Queue removal plus notice",
      "Queue new confirmation, +60s",
      "Worker runs every 2 minutes",
      "Send replaced notice as calls@",
      "Send new confirmation next",
      "Q: Send failed? Park or retry"
    ],
    "messages": [
      {
        "step": "Step 1 · old time",
        "subject": "Your previous Agent Call time was replaced",
        "gist": "Says \"Your previous time has been cancelled and replaced by your new booking.\" then the calendar handoff line and a manage link. Headline: Booking rescheduled.",
        "delay": "Within about 2 minutes of rebooking"
      },
      {
        "step": "Step 2 · new time",
        "subject": "Your agent call with Raydar is booked",
        "gist": "The ordinary confirmation for the new booking, sent as its own separate email with its own hold. The two are never merged into one.",
        "delay": "A minute later, after the replaced notice"
      }
    ],
    "status": "live",
    "ifDown": "Same outbox and tile as confirmations: red here means the scheduler’s sender is broken for confirmations, cancellations and reschedules alike."
  },
  {
    "id": "calendar-invites",
    "group": "scheduler",
    "mailbox": "none",
    "healthId": "email-scheduler-sender",
    "schedule": {
      "kind": "event"
    },
    "name": "Google Calendar invitations",
    "system": "Raydar Scheduler",
    "summary": "Google Calendar itself emails the candidate the invitation, updates and cancellation notices for every booking, because Raydar writes the event with notifications on. Raydar neither writes nor sends these messages.",
    "sender": "calls@raydar.xyz · sent by Google Calendar",
    "recipient": "Candidate",
    "trigger": "Raydar creates, changes or deletes the candidate's calendar event with attendee notifications turned on.",
    "cadence": "One notice per calendar change, sent the moment the calendar write succeeds, ahead of the Raydar email.",
    "runsOn": "Google Calendar",
    "volume": "not measured, Raydar cannot see these sends",
    "rateLimit": "Not affected. These do not use the Gmail quota. A failed calendar write retries, then stops.",
    "stops": [
      "Staff copies of the event never mail anyone",
      "Test calendar events send no notices",
      "A failed removal stops after quarantine"
    ],
    "gotchas": [
      "Google Calendar sends no email reminders here: candidate events are set to a 10-minute popup only, with email reminders off.",
      "These invitations arrive before the Raydar confirmation, which waits 60 seconds and runs at a lower priority."
    ],
    "flow": [
      "Raydar writes the event",
      "Notifications set to all",
      "Reminders: popup 10 minutes",
      "Google emails the invitation",
      "Q: Staff copy? No notice",
      "On cancel: remove event first",
      "Google emails the removal",
      "No email reminder ever sent"
    ],
    "messages": [
      {
        "step": "Invitation · on booking",
        "subject": "not in code, written by Google Calendar",
        "gist": "Google's own wording. Raydar supplies the event title, a candidate-safe description, the Meet link on video calls, and \"Raydar will call you\" on phone calls.",
        "delay": "The moment the calendar event is created"
      },
      {
        "step": "Update or cancellation notice",
        "subject": "not in code, written by Google Calendar",
        "gist": "Google's own wording. Both Raydar emails hand this off, saying \"Google Calendar will send the matching event update separately.\"",
        "delay": "The moment the change or removal lands"
      }
    ],
    "status": "live",
    "ifDown": "Google sends these itself the moment the calendar write lands. If bookings confirm but invitations stop arriving, the calendar write is what failed; the tile only watches the scheduler around it."
  },
  {
    "id": "apps-script-reply",
    "group": "mailbox",
    "mailbox": "david",
    "healthId": "lane-apps-script-auto-reply",
    "schedule": {
      "kind": "marks",
      "minutes": [
        0,
        30
      ],
      "tz": "UTC"
    },
    "name": "Paraform candidate auto reply",
    "system": "Paraform candidate auto-reply",
    "summary": "A script running inside David's own mailbox answers every Paraform connector referral with one welcome reply to the candidate. It has no server and no rate limit handling, and its own timer held the 37 hour mailbox lockout open.",
    "sender": "david@raydar.xyz · in-mailbox script",
    "recipient": "Candidate",
    "trigger": "A Paraform referral email arrives in David's mailbox and resolves cleanly to one named candidate.",
    "cadence": "Every 30 minutes, around the clock, no quiet hours. One reply per thread, ever.",
    "runsOn": "Inside the david@ mailbox, not the service account",
    "volume": "Caps at 20 per run; about 100 sent in two hours draining a backlog",
    "rateLimit": "None at all: no retry, no backoff. Its own timer kept the mailbox locked for 37 hours.",
    "stops": [
      "Already replied, or a draft exists on the thread",
      "Any wording drift fails closed, so nothing sends",
      "Only deleting the timer truly stops it"
    ],
    "gotchas": [
      "Turning off sending does not stop the timer: it still burns mailbox quota. Only deleting the timer is a real off switch.",
      "A run that reports Completed can still be rejecting every referral. One drift week left roughly 46 candidates a day unanswered."
    ],
    "flow": [
      "Timer fires every 30 minutes",
      "Find new Paraform referrals",
      "Q: One candidate resolved?",
      "Q: Thread already handled?",
      "Send one reply to candidate",
      "Check the sent copy is clean",
      "Label thread, log the send"
    ],
    "messages": [
      {
        "step": "Step 1 · only reply",
        "subject": "{Referrer full name} referred you to Paraform - Next Steps",
        "gist": "Warm welcome in David's voice: \"So great to meet you!\" It points at the screening call that collects preferences and matches them to Paraform clients.",
        "delay": "Within about 30 minutes of the referral"
      }
    ],
    "status": "live",
    "ifDown": "The paused chip is the watcher, not the lane: the script still replies every 30 minutes inside the mailbox, and the board cannot currently see it fail. It is the lane that sustained the 08-10 lockout at its old 10-minute cadence."
  },
  {
    "id": "hm-chase",
    "group": "sa",
    "mailbox": "david",
    "healthId": "lane-hm-chase",
    "schedule": {
      "kind": "none"
    },
    "name": "Hiring manager chase, candidate email",
    "system": "Hiring manager update chase",
    "summary": "When a client asks something only the candidate can answer, this drafts a short email as David, then sends that exact draft 12 hours later if he has not touched it. Paused since 8 August because clients were getting annoyed.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "Candidate",
    "trigger": "A client comment on a Paraform thread needs an answer only the candidate has, and they are still live.",
    "cadence": "Every 30 minutes when installed. Draft on the tick, send 12 hours later. Nothing is installed today.",
    "runsOn": "Desktop launchd, not installed",
    "volume": "Caps 2 a tick, 12 a day. One live send observed, on 31 July",
    "rateLimit": "Reads retry twice. The send never retries: it checks Sent once, then flags David and stops.",
    "stops": [
      "David edits, sends, or bins the draft",
      "Candidate already replied on the thread",
      "Anything mailed to them in the last 72 hours"
    ],
    "gotchas": [
      "A threaded chase arrives under the existing conversation title, not the template subject, and carries no signature the second time.",
      "Written records disagree with what runs: they list different caps, and one still says this lane is done and running."
    ],
    "flow": [
      "Tick every 30 minutes",
      "Q: Is the client waiting?",
      "Q: Candidate still on market?",
      "Write a draft, send nothing",
      "12 hour hold, David can veto",
      "Q: Edited, replied, or mailed?",
      "Send that exact draft once",
      "Tell the client it is done"
    ],
    "messages": [
      {
        "step": "Variant 1 · interview booked",
        "subject": "Quick one on {Company}",
        "gist": "\"Quick one - did you manage to get your interview with {Company} booked in for the {Role} role?\" plus \"nothing has slipped through the cracks.\"",
        "delay": "Drafted on the tick, sent 12 hours later"
      },
      {
        "step": "Variant 2 · candidate quiet",
        "subject": "Checking in on {Company}",
        "gist": "\"Just checking in on where you are with {Company} for the {Role} role. Let me know if anything has changed on your side or if you need anything from me.\"",
        "delay": "Drafted on the tick, sent 12 hours later"
      },
      {
        "step": "Variant 3 · never auto-sent",
        "subject": "Availability for {Company}",
        "gist": "\"{Company} are ready to get time in for the {Role} role. What does your availability look like over the next week or so?\" Stays a draft David sends himself.",
        "delay": "Drafted on the tick, never auto-sent"
      }
    ],
    "status": "paused",
    "ifDown": "Cannot be down: nothing is installed. The paused chip is accurate, and arming it is a decision, not a repair.",
    "statusReason": "Paused on purpose: David retired the desktop job on 8 August because clients were getting annoyed, so nothing runs today. Restarting it needs his explicit go and a cadence redesign; the draft-then-send machinery itself is complete."
  },
  {
    "id": "trademark-watch",
    "group": "sa",
    "mailbox": "david",
    "healthId": "gha-trademark-watch",
    "schedule": {
      "kind": "daily",
      "times": [
        "13:00"
      ],
      "tz": "UTC",
      "also": "1st of month at 13:10 UTC"
    },
    "name": "Trademark watch alerts",
    "system": "Trademark watch",
    "summary": "A daily job checks the USPTO for the two Raydar applications and two conflicting marks, and emails David the day anything moves. A monthly digest always sends, so silence means the watcher is dead.",
    "sender": "david@raydar.xyz · service account",
    "recipient": "David",
    "trigger": "A watched trademark status changes, or the 1st of the month arrives, which sends whether anything moved or not.",
    "cadence": "Daily at 13:00 UTC, change only. The 1st of the month at 13:10 UTC, always.",
    "runsOn": "GitHub Actions",
    "volume": "2 emails per send, one per address. One change alert since launch.",
    "rateLimit": "No retry. It checks Sent first, sends once, then fails the job so GitHub emails the failure.",
    "stops": [
      "A quiet day sends nothing at all",
      "An already delivered copy is never sent twice",
      "An unreadable filing fails the job, sends nothing"
    ],
    "gotchas": [
      "Silence is the alarm. No digest by the 3rd of a month means the watcher is dead, and nothing else checks that the email arrived.",
      "The monthly schedule has never actually fired yet: the one digest so far was sent by hand. First real run is 1 September."
    ],
    "flow": [
      "Daily check at 13:00 UTC",
      "Read the USPTO status pages",
      "Q: Any filing unreadable?",
      "Q: Any status changed?",
      "Q: Urgent wording matched?",
      "Email David at both addresses",
      "Save the record, beat health"
    ],
    "messages": [
      {
        "step": "Change alert · daily 13:00",
        "subject": "Raydar trademark — status changed ({n})",
        "gist": "A plain-text digest headed \"STATUS CHANGE DETECTED\" with was and now lines per filing, then current status for all four filings and the deadlines to watch.",
        "delay": "Within a day of the change appearing"
      },
      {
        "step": "Urgent escalation · any mode",
        "subject": "⚠ ACTION REQUIRED — Raydar trademark: {labels}",
        "gist": "Same digest, with each urgent filing flagged \"⚠ ACTION MAY BE REQUIRED\" and the clocks spelled out: a non-final action gives THREE MONTHS to respond.",
        "delay": "Same run, whenever urgent wording matches"
      },
      {
        "step": "Monthly digest · 1st, 13:10",
        "subject": "Raydar trademark — monthly status, all normal",
        "gist": "\"No change since the last check. Both applications are progressing normally.\" The footer states the rule: treat a missing digest as an alarm.",
        "delay": "1st of each month, moved or not"
      }
    ],
    "status": "live",
    "ifDown": "The board watches only the Actions run: a failed run reports a fail beat at once, and sustained silence goes down after three days. The emails themselves have no tile — the monthly digest is the dead-man’s switch, so no digest by the 3rd of the month means the watcher is dead."
  },
  {
    "id": "cold-sourcing",
    "group": "external",
    "mailbox": "paraform-fleet",
    "healthId": "email-paraform-mailboxes",
    "schedule": {
      "kind": "daily",
      "times": [
        "09:00"
      ],
      "tz": "PT",
      "window": "09:00-18:00 PT, weekdays"
    },
    "name": "Cold sourcing outreach sequence",
    "system": "Paraform cold outreach fleet",
    "summary": "A three step cold pitch to candidates Raydar sourced rather than applicants, sent by Paraform from the 26 alias inboxes across ten Raydar outreach domains. It is the only candidate facing family that never touches David's mailbox.",
    "sender": "26 cold aliases · sent by Paraform",
    "recipient": "Sourced candidate",
    "trigger": "An operator confirms enrollment for the candidates reviewed as Good, then David switches the sequence on.",
    "cadence": "3 steps: day 0, +3 days, +4 days. Sends 09:00 to 18:00 PT, weekdays only.",
    "runsOn": "Paraform platform",
    "volume": "Capped at 20 per inbox per day. Aggregate volume not measured.",
    "rateLimit": "Not a Gmail lane. Separate mailboxes, so it survived the David mailbox lockout untouched.",
    "stops": [
      "Enrollment blocked if booked, protected or enrolled",
      "A sequence left disabled sends nothing at all",
      "Kyra Wyman's roles are hard excluded, no override"
    ],
    "gotchas": [
      "This is the only candidate facing family off the crowded david@ mailbox, which is why it kept sending through the August lockout.",
      "Older live sequences use an old booking link, new ones use a new link. Both reach the intro call, so traffic shows two sources."
    ],
    "flow": [
      "Approved role chosen",
      "Cold sequence built, disabled",
      "Sourced candidates reviewed",
      "Operator enrolls the Good ones",
      "Q: Booked or excluded?",
      "David turns the sequence on",
      "Paraform sends 3 alias emails",
      "Candidate books a call"
    ],
    "messages": [
      {
        "step": "Step 1",
        "subject": "not in code, built at send time from role facts",
        "gist": "100 to 180 factual words: company facts, role, work model, bold pay, the job link, and a call link. Ends \"Interested? Grab time here\" with the booking link.",
        "delay": "Day 0, the day the sequence is created"
      },
      {
        "step": "Step 2",
        "subject": "(blank, so it threads under step 1)",
        "gist": "Short nudge carrying the locked \"Any interest in this role?\" line, signed as David.",
        "delay": "3 days after step 1"
      },
      {
        "step": "Step 3",
        "subject": "(blank, threads as a follow-up)",
        "gist": "Locked final follow up, ending \"Best, David\".",
        "delay": "4 days after step 2 (live fleet shows 2)"
      }
    ],
    "status": "live",
    "ifDown": "The fleet card watches gmail status through Paraform: any alias in error means pause its sequences before the domain burns. Warmup keeps background volume flowing, so a quiet campaign is not evidence of a healthy mailbox."
  },
  {
    "id": "calendly-role-chat",
    "group": "scheduler",
    "mailbox": "none",
    "healthId": "n8n-workflows",
    "schedule": {
      "kind": "every",
      "n": 1,
      "offset": 0,
      "tz": "UTC"
    },
    "name": "Calendly role chat invite updates",
    "system": "Calendly Alzen booking assistant",
    "summary": "Every new Calendly Role Chat booking on David's calendar gets Alzen added as an attendee, so Google Calendar emails an updated invitation to the candidate and a first invitation to Alzen. No Gmail quota is used.",
    "sender": "david@raydar.xyz · sent by Google Calendar",
    "recipient": "Candidate and Alzen",
    "trigger": "A new event matching the exact Calendly Role Chat title and description pattern lands on David's calendar.",
    "cadence": "Calendar checked every minute. One update wave per booking, sent within about a minute.",
    "runsOn": "n8n Cloud, mail sent by Google",
    "volume": "One update wave per qualifying booking. Not measured.",
    "rateLimit": "No Gmail quota at all. A failed calendar update retries 3 times, then fails loudly.",
    "stops": [
      "One patch per event, so one update wave",
      "Events that do not match the pattern mail nobody",
      "A failed update fails loudly, never silently"
    ],
    "gotchas": [
      "The candidate gets a second calendar email for a call they already booked. That is the unavoidable cost of inviting Alzen.",
      "These bookings write nothing to Paraform, so any sweep built on Paraform alone misses them, as it did for 69 of 161 bookings."
    ],
    "flow": [
      "Candidate books a Role Chat",
      "Calendar checked every minute",
      "Q: Exact Role Chat match?",
      "Rebuild attendees, add Alzen",
      "Save event, Google mails all",
      "Candidate and Alzen emailed",
      "Q: Alzen on the event?",
      "Slack note to Alzen"
    ],
    "messages": [
      {
        "step": "Step 1 · only message",
        "subject": "not in code, Google Calendar writes the invitation subject",
        "gist": "Google's own invitation email: event title, time, Meet link, and the attendee list now including Alzen. The description stays Calendly's original text, untouched.",
        "delay": "Within about a minute of the booking"
      }
    ],
    "status": "live",
    "ifDown": "An n8n cloud workflow patching the calendar every minute; failure streaks surface on the n8n tile. Google then emails the update itself, so patches succeeding without mail arriving points at Google’s send, not ours."
  },
  {
    "id": "slack-prefilled",
    "group": "mailbox",
    "mailbox": "david",
    "healthId": null,
    "schedule": {
      "kind": "event",
      "note": "Alerts every 10 min, 06:00-21:00 PT weekdays"
    },
    "name": "Slack prefilled candidate emails",
    "system": "Paraform notify Slack actions",
    "summary": "Six ready written candidate emails sit behind the Email candidate button on Raydar's Slack notifications. David taps one, Gmail opens prefilled from his own account, and nothing sends until he presses Send himself.",
    "sender": "david@raydar.xyz · manual send in Gmail",
    "recipient": "Candidate",
    "trigger": "David clicks Email candidate on a Slack notification about a rejection, hire, interview or scheduling step.",
    "cadence": "One email per human click. The Slack alerts offering it post every 10 minutes, 06:00 to 21:00 PT weekdays.",
    "runsOn": "n8n Cloud alerts, sent from David's browser",
    "volume": "Not measured. Depends entirely on how often David clicks.",
    "rateLimit": "None. It is an ordinary human Gmail send on the shared david@ mailbox, no retry.",
    "stops": [
      "No click, no email. There is no automatic send.",
      "Unknown address turns the button into Find email",
      "Marking the alert handled mails nobody"
    ],
    "gotchas": [
      "Two of the six templates promise a call with no booking link, so they rely on the candidate replying.",
      "The copy is held on Raydar's side, so editing it changes what candidates read even though a human presses Send."
    ],
    "flow": [
      "Paraform notification arrives",
      "Alert posts to Slack",
      "Q: Candidate email known?",
      "David taps Email candidate",
      "Gmail opens prefilled",
      "David edits and sends",
      "Mail leaves david@raydar.xyz"
    ],
    "messages": [
      {
        "step": "Template 1 · rejected",
        "subject": "Update on {Company}",
        "gist": "Tells the candidate the company passed, then pivots: \"I think you're a strong fit for a couple of other roles I'm working on; mind if I share them?\" Signed David.",
        "delay": "On click, after a rejection notice"
      },
      {
        "step": "Template 2 · hired",
        "subject": "Congratulations! 🎉",
        "gist": "Short congratulations on the offer or hire: \"really happy for you\", plus an offer to talk through next steps.",
        "delay": "On click, after an offer or hire"
      },
      {
        "step": "Template 3 · interview booked",
        "subject": "Prep for your {Company} interview",
        "gist": "Offers a \"quick 15-min prep call\" before the booked interview, and to share what David knows about the process.",
        "delay": "On click, once an interview is booked"
      },
      {
        "step": "Template 4 · interview done",
        "subject": "How did the {Company} interview go?",
        "gist": "Asks how it went and whether there is any feedback to pass along.",
        "delay": "On click, after an interview completes"
      },
      {
        "step": "Template 5 · they want to talk",
        "subject": "{Company} wants to interview you",
        "gist": "\"Great news\": the company wants an interview, and asks for 15 minutes this week before David confirms.",
        "delay": "On click, on an action required alert"
      },
      {
        "step": "Template 6 · scheduling chase",
        "subject": "Scheduling your interview",
        "gist": "Checks whether interview times came through, and offers to push for more options if none work.",
        "delay": "On click, on a scheduling alert"
      }
    ],
    "status": "human-initiated",
    "ifDown": "Nothing automated to break: sends happen from David’s browser. If the buttons stop appearing in Slack, the n8n notify workflow is the thing to check."
  },
  {
    "id": "olivia",
    "group": "external",
    "mailbox": "olivia",
    "healthId": null,
    "schedule": {
      "kind": "none"
    },
    "name": "Olivia agent email",
    "system": "Olivia recruiting agent",
    "summary": "Olivia is a Slack recruiting agent with a working send path on her own mailbox: internal Raydar addresses go out with no approval, external ones wait for a thumbs up in Slack. She is built and verified but has never sent a live email.",
    "sender": "olivia@raydar.xyz · own mailbox",
    "recipient": "Anyone the task names",
    "trigger": "A Raydar person mentions Olivia in Slack with a task and she decides to send mail.",
    "cadence": "No schedule. One email per task, sent as soon as it is approved.",
    "runsOn": "A desktop process, not in production",
    "volume": "Zero to date. No cap of any kind.",
    "rateLimit": "No handling at all. A failed send is logged and dropped, with no retry or backoff.",
    "stops": [
      "Without mailbox access it is only saved locally",
      "External recipients wait for approval, expiring in 24h",
      "David can pause or hard stop her from Slack"
    ],
    "gotchas": [
      "Internal email is auto approved. The moment her mailbox is connected she can email any raydar.xyz address with no human check.",
      "The internal versus external list is unfinished, so a teammate can be misread as external. It over gates, it never under gates."
    ],
    "flow": [
      "Someone tasks Olivia in Slack",
      "Agent plans the task",
      "Agent drafts the email",
      "Q: Every recipient internal?",
      "External waits for a yes",
      "Q: Mailbox access ready?",
      "No access, saved locally",
      "Live send from olivia@"
    ],
    "messages": [
      {
        "step": "Step 1 · only message",
        "subject": "not in code, Olivia writes each subject at the time",
        "gist": "Written fresh by the agent each time, plain text, no fixed copy. The prompt shapes it as outreach drafting, and anything she reads is treated as data, never orders.",
        "delay": "Internal sends at once, external after a yes"
      }
    ],
    "status": "deprecated",
    "ifDown": "Nothing to watch until she launches: no schedule exists and her mailbox has sent zero emails, so there is no state this page could report.",
    "statusReason": "Abandoned 2026-08-18 on David’s order: fully built, never launched, zero emails sent. Code removal is a later cleanup; nothing runs."
  }
];
