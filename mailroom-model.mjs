export const VIEWS = { sent: 'Sent', queued: 'Queued', attention: 'Needs attention', all: 'All emails', lanes: 'Sending lanes' };
export const DELIVERY_LABELS = { delivered: 'Delivered', accepted: 'Accepted', bounced: 'Bounced', blocked: 'Blocked', dropped: 'Dropped', spam: 'Spam reported', unsubscribed: 'Unsubscribed', unknown: 'Unknown', queued: 'Queued', cancelled: 'Cancelled', deferred: 'Deferred', failed: 'Failed', rejected: 'Rejected' };
export const EMPTY_FILTERS = { view: 'sent', q: '', lane: '', sender: '', delivery: '', from: '', to: '', id: '' };
export const EMAIL_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

// Registry notes often describe setup-time state. Purpose text is independent
// of those notes; the live enabled field remains the displayed lane setting.
const LANE_PURPOSES = {
  'applicant-core-interview': 'Sends interview invitations to approved applicants.',
  'canary': 'Sends test emails to David to verify email delivery.',
  'interview-outage-apology': 'Sends an apology and rebooking invitation after a missed interview caused by an outage.',
  'match-none': 'Follows up after a screening call when no matching openings are available.',
  'match-watch': 'Sends new role matches and their follow-ups.',
  'paraai-outreach-relief': 'Sends approved replacement outreach during a Para AI sending incident.',
  'postcall-general-many': 'Shares two or more new role matches after a general screening call.',
  'postcall-general-no-new': 'Follows up after a repeat screening call when earlier matches remain available and no new roles were found.',
  'postcall-general-none': 'Follows up after a general screening call when no matching roles are available.',
  'postcall-general-one': 'Shares one new role match after a general screening call.',
  'postcall-match-correction': 'Sends an approved correction when a post-call email omitted suitable role matches.',
  'postcall-role-bad-matches': 'Shares other new matches after a screening call when the discussed role is not a fit.',
  'postcall-role-bad-no-new': 'Revisits earlier matches when the discussed role is not a fit and no new roles were found.',
  'postcall-role-bad-none': 'Follows up when the discussed role is not a fit and no other matches are available.',
  'postcall-role-good-matches': 'Follows up on a suitable role and shares other new matches after a screening call.',
  'postcall-role-good-no-new': 'Follows up on a suitable role and earlier matches when no new roles were found.',
  'postcall-role-good-none': 'Follows up on a suitable role when no other matches are available.',
};

export function lanePurpose(lane = {}) {
  const id = String(lane.id || '');
  if (Object.hasOwn(LANE_PURPOSES, id)) return LANE_PURPOSES[id];
  if (id.startsWith('master-inbox-human-')) return 'Sends emails and replies reviewed by a person in Master Inbox.';
  if (/^holiday-human-reschedule-\d{4}-\d{2}-\d{2}$/.test(id)) return 'Sends a holiday notice and rescheduling options for confirmed intro calls.';
  return 'A purpose description has not been added for this lane.';
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : '';
}

export function normalizeFilters(value = {}) {
  return {
    view: Object.hasOwn(VIEWS, value.view) ? value.view : 'sent',
    q: String(value.q || '').slice(0, 500),
    lane: String(value.lane || '').slice(0, 200),
    sender: String(value.sender || '').slice(0, 200),
    delivery: Object.hasOwn(DELIVERY_LABELS, value.delivery) ? value.delivery : '',
    from: validDate(value.from), to: validDate(value.to),
    id: String(value.id || '').slice(0, 512),
  };
}

export function stateAddress(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(normalizeFilters(filters))) if (value && (key !== 'view' || value !== 'sent')) params.set(key, value);
  return 'browse' + (params.size ? '?' + params.toString() : '');
}

export function addressState(address = '') {
  const query = address.startsWith('browse') ? address.slice(address.indexOf('?') + 1) : address.replace(/^\?/, '');
  return normalizeFilters(address === 'browse' ? {} : Object.fromEntries(new URLSearchParams(query)));
}

export function localDayBound(value, nextDay = false) {
  if (!validDate(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

export function listQuery(filters, cursor = '') {
  const state = normalizeFilters(filters);
  const query = new URLSearchParams({ mode: 'list', view: state.view === 'lanes' ? 'all' : state.view, limit: '50' });
  for (const key of ['q', 'lane', 'sender', 'delivery']) if (state[key]) query.set(key, state[key]);
  if (state.from) query.set('from', localDayBound(state.from));
  if (state.to) query.set('to', localDayBound(state.to, true));
  if (cursor) query.set('cursor', cursor);
  return query;
}

export function displayNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
}

export function statusKey(row = {}) {
  const status = String(row.delivery_status || '').toLowerCase();
  return Object.hasOwn(DELIVERY_LABELS, status) ? status : 'unknown';
}

export function statusExplanation(row = {}) {
  switch (statusKey(row)) {
    case 'delivered': return 'SendGrid recorded delivery to the recipient’s mail server. This does not confirm that the person read the email.';
    case 'accepted': return 'The email provider accepted this email for sending. A confirmed delivery event has not been recorded.' + (row.transport_evidence === 'current_sender_registry' ? ' The sending service is based on the sender’s current setting.' : '');
    case 'queued': return 'This email is waiting in Mailroom. Provider acceptance and delivery have not been confirmed.';
    case 'bounced': return 'The recipient’s mail server rejected this email. See the delivery events for the recorded reason.';
    case 'blocked': return 'Sending was blocked. See the recorded error and delivery events for more detail.';
    case 'dropped': return 'SendGrid dropped this email instead of delivering it. See the delivery events for the reason.';
    case 'spam': return 'A spam complaint was recorded for this email. The event history shows any earlier delivery.';
    case 'unsubscribed': return 'An unsubscribe event was recorded for this email. The event history shows any earlier delivery.';
    case 'cancelled': return 'This email was cancelled in Mailroom. See the recorded state and events for its history.';
    default: return 'The available records do not confirm the delivery outcome. A Mailroom state alone is not proof of delivery.' + (row.state === 'sent' && !row.provider_message_id ? ' This historical sent record has no stored provider receipt.' : '');
  }
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

// The empty iframe sandbox is a second independent boundary. This CSP is always
// inserted before message content, so stored HTML cannot relax its restrictions.
export function wrapSafeEmailHTML(sanitizedHTML) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escapeHTML(EMAIL_CSP) + '"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light}body{margin:16px;font:14px/1.65 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:inherit;pointer-events:none}</style></head><body>' + sanitizedHTML + '</body></html>';
}

export function createRequestGate() {
  let controller = null;
  let version = 0;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const current = ++version;
      return { signal: controller.signal, isCurrent: () => version === current && !controller.signal.aborted };
    },
    cancel() { version++; controller?.abort(); },
  };
}

export function mergeMessageRows(previous, incoming) {
  const seen = new Set(previous.map(row => String(row.id)));
  return [...previous, ...incoming.filter(row => { const key = String(row.id); if (seen.has(key)) return false; seen.add(key); return true; })];
}
