// Synthetic fixture data for the scripted employee tests
// (test/master-inbox-employee.test.mjs). Every address is example.test and
// every id is deterministic so tests can assert on exact values. No
// candidate PII, no real Raydar addresses, no credentials.
//
// Shape mirrors what the deployed store actually returns, per
// master-inbox/lib/repository.mjs and lib/coverage.mjs (see FACTS.md):
// GET /api/master-inbox/feed -> { ok, rows, cursor, hasMore, mailboxes,
//   coverage, query }; GET /api/master-inbox/thread -> { ok, conversation }.

const MAILBOX_IDS = [
  'alex-example-test', 'blair-example-test', 'casey-example-test',
  'devon-example-test', 'ellis-example-test', 'frankie-example-test',
  'gray-example-test', 'harper-example-test', 'indigo-example-test',
  'jules-example-test',
];

function uuidFor(n) {
  const hex = n.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

export function buildMailboxes() {
  return MAILBOX_IDS.map((id, index) => ({
    id,
    principal: id.replace(/-example-test$/, '@example.test'),
    visible_addresses: [id.replace(/-example-test$/, '@example.test')],
    // mailbox index 1 (blair) is the one stale mailbox in coverage below
    inbox_count: 40 + index,
    unread_count: index === 0 ? 3 : index,
    // Every fixture mailbox can send: the composer's identity picker
    // (master-inbox-composer.mjs updateIdentities()) filters to
    // box.capabilities?.send, so a fixture without this silently produces
    // an empty From select and every reply/compose assertion fails for a
    // fixture reason, not a page reason.
    capabilities: { send: true },
  }));
}

const NOW = Date.parse('2026-09-10T18:00:00.000Z');
const STALE_MAILBOX = MAILBOX_IDS[1]; // blair-example-test

export function buildCoverage({ asOf = new Date(NOW).toISOString() } = {}) {
  const mailboxes = MAILBOX_IDS.map((id, index) => {
    const isStale = id === STALE_MAILBOX;
    return {
      id,
      principal: id.replace(/-example-test$/, '@example.test'),
      status: isStale ? 'stale' : 'current',
      lastErrorClass: null,
      syncedThrough: isStale
        ? new Date(NOW - 20 * 60 * 1000).toISOString()
        : new Date(NOW - 30 * 1000).toISOString(),
      lagSeconds: isStale ? 1200 : 20,
      history: { importState: 'complete', oldestAt: '2024-01-01T00:00:00.000Z' },
    };
  });
  return {
    asOf,
    summary: {
      mailboxes: MAILBOX_IDS.length,
      current: MAILBOX_IDS.length - 1,
      stale: [STALE_MAILBOX],
      unknown: [],
      watermark: new Date(NOW - 20 * 60 * 1000).toISOString(),
    },
    mailboxes,
    scope: { mailboxIds: MAILBOX_IDS },
    negativeEvidence: {
      kind: 'none_through_watermark',
      watermark: new Date(NOW - 20 * 60 * 1000).toISOString(),
      spamAndTrashExcludedFromBackfill: true,
    },
  };
}

// 60 synthetic conversations, newest first, spread across the 10 mailboxes.
export function buildConversations() {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const mailboxIndex = i % MAILBOX_IDS.length;
    const mailboxId = MAILBOX_IDS[mailboxIndex];
    const address = mailboxId.replace(/-example-test$/, '@example.test');
    const outbound = i % 5 === 0;
    const newestAt = new Date(NOW - i * 15 * 60 * 1000).toISOString();
    rows.push({
      id: uuidFor(i + 1),
      subject: `Role update ${i + 1}`,
      snippet: `Synthetic preview text for conversation ${i + 1}.`,
      newest_at: newestAt,
      unread: i % 7 === 0,
      starred: i % 11 === 0,
      last_direction: outbound ? 'outbound' : 'inbound',
      latest_from: outbound ? [{ name: 'Raydar Team', address }] : [{ name: `Contact ${i}`, address: `contact${i}@example.test` }],
      latest_to: outbound ? [{ name: `Contact ${i}`, address: `contact${i}@example.test` }] : [{ name: 'Raydar Team', address }],
      participant_text: outbound ? `contact${i}@example.test` : `contact${i}@example.test`,
      mailbox_ids: [mailboxId],
      matching_mailbox_ids: [mailboxId],
      message_count: 1 + (i % 3),
      message_copy_count: 1 + (i % 3),
      has_attachment: i % 4 === 0,
      attachments: { available: i % 4 === 0 ? 1 : 0 },
      folder: i % 13 === 0 ? 'sent' : i % 17 === 0 ? 'drafts' : 'inbox',
    });
  }
  return rows;
}

export function buildThread(id) {
  const rows = buildConversations();
  const row = rows.find(item => item.id === id);
  if (!row) return null;
  const mailboxId = row.mailbox_ids[0];
  return {
    id: row.id,
    subject: row.subject,
    coverage: null, // deliberately unset: deployed /api/conversation does not return notes
    messages: [
      {
        id: uuidFor(9000),
        mailbox_id: mailboxId,
        direction: row.last_direction,
        rfc_message_id: `<msg-${row.id}@example.test>`,
        provider_message_id: `prov-${row.id}`,
        internal_date: row.newest_at,
        safe_text: `Synthetic message body for ${row.subject}.`,
        safe_html: null,
        copies: [{ mailbox_id: mailboxId, id: `copy-${row.id}`, provider_message_id: `prov-${row.id}` }],
        attachments: [],
      },
    ],
    userState: [],
  };
}

export const FIXTURE_MAILBOX_IDS = MAILBOX_IDS;
export const FIXTURE_STALE_MAILBOX = STALE_MAILBOX;
export const FIXTURE_NOW = NOW;
