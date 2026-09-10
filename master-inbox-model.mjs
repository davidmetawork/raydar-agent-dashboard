/* Pure model for the Master Inbox page. No DOM, no fetch, no routing.

   ROUTING LIVES IN master-inbox-route.js, not here. That file is the one
   route contract for this page (browse?folder&mailbox&q&id, folder omitted
   only for the page default) and it is also what the shell's deep links and
   the scripted employee tests are written against, so this module never
   parses or serializes an address.

   SEARCH: the deployed store parses exactly these operators
   (master-inbox/lib/search.mjs): from:, to:, before:, after:, in:, mailbox:,
   label:, and the bare token has:attachment. Everything else — subject:,
   filename:, cc:, bcc:, is:unread — falls through into full-text terms
   silently. So every filter control on this page is a writer for one of the
   operators above, expressed inside `q`; the page sends the store nothing
   else. A control that cannot be written as a supported operator is not
   offered, because a filter that is silently ignored produces a confident
   wrong "no such email".
*/
export const FILTER_FIELDS = ['from', 'to', 'after', 'before'];
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
// The store's own tokenizer, so what the panel writes is what the store reads.
export function tokenizeQuery(input) { return String(input || '').match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) || []; }
const unquote = value => String(value).replace(/^"|"$/g, '').trim();
const quote = value => /[\s"]/.test(value) ? '"' + String(value).replaceAll('"', '') + '"' : String(value);
/** The filter panel's view of a query string. Anything the panel cannot own stays in `text` verbatim. */
export function parseFilters(query) {
  const filters = { from: '', to: '', after: '', before: '', unread: false, hasAttachment: false, text: '' };
  const rest = [];
  for (const raw of tokenizeQuery(query)) {
    const lower = raw.toLowerCase();
    if (lower === 'has:attachment') { filters.hasAttachment = true; continue; }
    if (lower === 'label:unread' || lower === 'label:"unread"') { filters.unread = true; continue; }
    const separator = raw.indexOf(':');
    if (separator > 0) {
      const field = raw.slice(0, separator).toLowerCase();
      const value = unquote(raw.slice(separator + 1));
      // Only the FIRST occurrence of a field belongs to the panel; a second
      // from: is a deliberate query the person typed, and it stays in the text.
      if (value && FILTER_FIELDS.includes(field) && !filters[field] && (!['after', 'before'].includes(field) || CALENDAR_DAY.test(value))) { filters[field] = value; continue; }
    }
    rest.push(raw);
  }
  filters.text = rest.join(' ');
  return filters;
}
/** The inverse: what the panel writes back into `q`. Dates are YYYY-MM-DD, the only form the store parses. */
export function composeQuery(filters) {
  const parts = [];
  for (const field of FILTER_FIELDS) { const value = String(filters?.[field] || '').trim(); if (value && (!['after', 'before'].includes(field) || CALENDAR_DAY.test(value))) parts.push(field + ':' + quote(value)); }
  if (filters?.unread) parts.push('label:unread');
  if (filters?.hasAttachment) parts.push('has:attachment');
  const text = String(filters?.text || '').trim();
  if (text) parts.push(text);
  return parts.join(' ');
}
/** The five parameters the feed proxy forwards, and nothing else. */
export function feedQuery(route, cursor) {
  const params = new URLSearchParams({ folder: String(route?.folder || 'all'), limit: '50' });
  if (route?.mailbox) params.set('mailbox', route.mailbox);
  if (route?.q) params.set('q', route.q);
  if (cursor) params.set('cursor', cursor);
  return params;
}
export const EMAIL_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
export function contacts(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? { address: item } : item).filter(Boolean);
  if (value && typeof value === 'object') return [value];
  const raw = String(value || '').trim();
  try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return contacts(parsed); if (parsed && typeof parsed === 'object') return [parsed]; } catch {}
  const rows = []; for (const match of raw.matchAll(/\{[^{}]*\}/g)) try { const row = JSON.parse(match[0]); if (row.name || row.address) rows.push(row); } catch {}
  if (rows.length) return rows;
  const tokens = []; let current = ''; let quoted = false; let depth = 0; let escaped = false; for (const character of raw) { if (escaped) { current += character; escaped = false; continue; } if (character === '\\' && quoted) { current += character; escaped = true; continue; } if (character === '"') quoted = !quoted; if (!quoted && character === '<') depth++; if (!quoted && character === '>') depth = Math.max(0, depth - 1); if (!quoted && depth === 0 && /[,;]/.test(character)) { if (current.trim()) tokens.push(current.trim()); current = ''; } else current += character; } if (current.trim()) tokens.push(current.trim());
  return raw ? tokens.map(value => { const match = value.trim().match(/^(.*?)\s*<([^>]+)>$/); return match ? { name: match[1].replace(/^"|"$/g, '').trim(), address: match[2].trim() } : { address: value.trim() }; }) : [];
}
export const firstContact = value => contacts(value)[0] || null;
export const addressKey = value => String(value || '').trim().toLowerCase();
export function displayText(value) { return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => { const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }; if (named[code.toLowerCase()]) return named[code.toLowerCase()]; const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity; } catch { return entity; } }); }
export const contactLabel = value => { const person = firstContact(value); return displayText(person?.name || person?.address || 'Unknown participant'); };
export const fullContacts = value => contacts(value).map(person => person.name && person.address ? `${/[,;"]/u.test(person.name) ? '"' + String(person.name).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"' : person.name} <${person.address}>` : person.address || person.name).filter(Boolean).join(', ');
export const mailboxAddresses = box => [...new Set([box?.principal, ...(box?.visible_addresses || [])].filter(Boolean).map(addressKey))];
/* Who this conversation is WITH, for a folder where the sender is always us.

   BEST EFFORT, and deliberately labelled as such: the feed has no counterparty
   field, so this takes every participant recorded on the row and removes the
   addresses that belong to the company's own mailboxes. The first address left
   is treated as the outside person. It is wrong for a purely internal thread
   (there is no outside person, and the recorded label is used instead) and it
   can pick the wrong person when several outsiders are on one thread. When the
   store learns a counterparty field, this function is what it replaces. */
export function externalParticipant(row, ownAddresses = []) {
  const own = new Set([...ownAddresses].map(addressKey).filter(Boolean));
  const people = [...contacts(row?.latest_to), ...contacts(row?.latest_from), ...contacts(row?.participant_text)];
  const outside = people.find(person => person.address && !own.has(addressKey(person.address)));
  return outside ? displayText(outside.name || outside.address) : '';
}
export function rowParticipant(row) { if (row.display_participant) return displayText(row.display_participant); const people = row.last_direction === 'outbound' ? row.latest_to : row.latest_from; return contacts(people).length ? contactLabel(people) : contactLabel(row.participant_text); }
export function logicalMessages(messages) {
  const groups = new Map();
  for (const message of messages || []) { const key = message.rfc_message_id ? `rfc:${message.rfc_message_id}` : `record:${message.id}`; if (!groups.has(key)) groups.set(key, { ...message, copies: [] }); groups.get(key).copies.push(message); }
  return [...groups.values()].sort((a, b) => new Date(a.internal_date || a.created_at).valueOf() - new Date(b.internal_date || b.created_at).valueOf());
}
export function chooseReplyMessage(thread, mailboxId) { const messages = (thread?.messages || []).filter(message => message.direction !== 'draft' && !(['local_send', 'mailroom'].includes(message.source) && ['held', 'queued', 'releasing', 'failed', 'parked', 'pending', 'draft'].includes(message.send_state || message.source_state))); return (mailboxId ? messages.filter(message => message.mailbox_id === mailboxId) : messages).at(-1) || messages.at(-1) || null; }
export function replyDefaults(message, mailbox, mode = 'reply') {
  const identities = new Set(mailboxAddresses(mailbox));
  const outbound = message?.direction === 'outbound' || contacts(message?.from_json).some(person => identities.has(addressKey(person.address)));
  const outgoingFrom = contacts(message?.from_json).find(person => identities.has(addressKey(person.address)))?.address;
  const receivedAs = [...contacts(message?.to_json), ...contacts(message?.cc_json)].find(person => identities.has(addressKey(person.address)))?.address;
  const from = outbound ? outgoingFrom || mailbox?.principal : receivedAs || mailbox?.principal;
  const unique = people => { const found = new Set(); return contacts(people).filter(person => { const key = addressKey(person.address); if (!key || identities.has(key) || found.has(key)) return false; found.add(key); return true; }); };
  const to = unique(outbound ? message?.to_json : contacts(message?.reply_to_json).length ? message.reply_to_json : message?.from_json);
  const toKeys = new Set(to.map(person => addressKey(person.address)));
  const cc = mode === 'reply-all' ? unique([...(outbound ? [] : contacts(message?.to_json)), ...contacts(message?.cc_json)]).filter(person => !toKeys.has(addressKey(person.address))) : [];
  return { from: from || '', to, cc, bcc: [], subject: /^re:/i.test(message?.subject || '') ? message.subject : 'Re: ' + (message?.subject || ''), inReplyTo: message?.rfc_message_id || null, references: [...new Set([...(Array.isArray(message?.references_header) ? message.references_header : String(message?.references_header || '').split(/\s+/)), message?.rfc_message_id].filter(Boolean))].join(' ') };
}
export function splitQuotedText(text) { const value = String(text || ''); const match = /\n(?:On [^\n]{3,250}wrote:\s*\n|[-_]{3,}\s*(?:Original|Forwarded) [Mm]essage\s*[-_]*\s*\n|>[^\n]*\n>)/m.exec(value); return match ? { body: value.slice(0, match.index), quoted: value.slice(match.index + 1) } : { body: value, quoted: '' }; }
export function messageDirection(message) { const status = message.send_state || message.source_state || message.delivery_status; if (message.direction === 'draft' || status === 'draft') return 'Draft'; if (message.direction === 'outbound' && ['held', 'queued', 'releasing', 'failed', 'parked', 'pending', 'scheduled', 'cancelled'].includes(status)) return ({held:'On hold',queued:'Queued',releasing:'Confirming send',failed:'Send failed',parked:'Needs review',pending:'Pending',scheduled:'Scheduled',cancelled:'Cancelled'})[status]; return message.direction === 'outbound' ? 'Sent' : message.direction === 'inbound' ? 'Received' : 'Conversation'; }
export function attachmentReason(file) { const messages = { stored_file_missing: 'The stored file is missing.', import_or_scan_pending: 'The file is being imported or checked.', scan_blocked: 'The file was blocked by the safety scan.', file_import_failed: 'The file could not be imported.' }; return messages[file.reason] || (file.reason ? String(file.reason).replaceAll('_', ' ') : ''); }
export function attachmentStatus(file) { if ((file.downloadAvailable ?? file.state === 'available') && file.state === 'available') return 'Available'; if (['pending', 'importing'].includes(file.state)) return 'Importing'; if (['blocked', 'quarantined'].includes(file.state)) return 'Blocked'; return 'Unavailable'; }
export function errorMessage(error) {
  const code = String(error?.code || error?.message || '').toLowerCase();
  if (code === 'search_unsupported_operator') return `This search operator is not supported${error.detail?.operator ? ': ' + error.detail.operator : ''}. Use the visible filters or supported search syntax.`;
  if (code === 'search_scope_conflict') return 'The search specifies a different folder. Choose that folder above or remove the in: operator.';
  if (code === 'monitor_session_expires_before_send') return 'Your sign-in expires before this scheduled send. Choose an earlier time or sign in again.';
  if (code.includes('search') || code.includes('date')) return 'This search could not be applied. Check the operators and date range.';
  if (code.includes('revision') || code.includes('lease')) return 'This draft changed in another session. Your text is preserved here. Reload the saved version or save a separate copy.';
  if (code.includes('recipient')) return 'Check the recipient email addresses.';
  if (code.includes('mailbox') || code.includes('identity')) return 'Choose an available sending address. This identity could not be verified.';
  if (code === 'attachment_size_limit') return 'Attachments must total 20 MB or less. Remove a file before saving or sending.';
  if (code.includes('attachment')) return 'An attachment is not ready. Check its status before sending.';
  if (error?.status === 401 || error?.status === 403) return 'Your session could not authorize this action. Sign in again.';
  return 'The request was not confirmed. Your current work is preserved; try again.';
}
export function requestGate() { let version = 0; let controller; return { begin() { controller?.abort(); controller = new AbortController(); const current = ++version; return { signal: controller.signal, current: () => current === version && !controller.signal.aborted }; }, cancel() { version++; controller?.abort(); } }; }
export function createSaveQueue(save) { let tail = Promise.resolve(); return task => { const run = tail.then(() => save(task)); tail = run.catch(() => {}); return run; }; }

// An uncertain response must replay the saved revision and key. Autosaving again
// could revise the payload, or fail because the first request already held it.
export function createSendRequest({ prepare, submit, makeKey = () => crypto.randomUUID() }) {
  let pending = null;
  const rejected = new Set(['send_disabled', 'draft_not_sendable', 'draft_editor_conflict', 'draft_revision_conflict', 'from_identity_unavailable', 'attachment_not_ready', 'monitor_session_expires_before_send']);
  return { get pending() { return pending; }, async run() {
    if (!pending) { const draft = await prepare(); if (!draft) return null; pending = Object.freeze({ draftId: draft.id, revision: draft.revision, idempotencyKey: makeKey(), scheduledFor: draft.scheduled_for || null }); }
    try { const result = await submit(pending); if (!result?.id || !result?.state) throw Object.assign(new Error('send_response_unconfirmed'), { code: 'send_response_unconfirmed', status: 502 }); pending = null; return result; }
    catch (error) { if (error?.status >= 400 && error.status < 500 && (rejected.has(String(error.code || error.message).toLowerCase()) || String(error.code || error.message).toLowerCase().startsWith('human_'))) pending = null; throw error; }
  } };
}
