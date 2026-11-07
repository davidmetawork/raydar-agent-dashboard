export const FOLDERS = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', starred: 'Starred', snoozed: 'Snoozed', 'all-mail': 'All mail', anywhere: 'All folders', spam: 'Spam', trash: 'Trash' };
export const FILTER_KEYS = ['from', 'to', 'subject', 'filename', 'after', 'before', 'read', 'hasAttachment'];
export const EMPTY_ROUTE = { folder: 'inbox', mailbox: '', q: '', id: '', from: '', to: '', subject: '', filename: '', after: '', before: '', read: '', hasAttachment: '' };
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
export function normalizedRoute(input = {}) { const result = { ...EMPTY_ROUTE }; result.folder = input.folder === 'all' ? 'inbox' : Object.hasOwn(FOLDERS, input.folder) ? input.folder : 'inbox'; for (const key of ['mailbox', 'q', 'id', ...FILTER_KEYS]) result[key] = String(input[key] || '').slice(0, key === 'q' ? 1000 : 300); if (!['read', 'unread'].includes(result.read)) result.read = ''; if (!['true', 'false'].includes(result.hasAttachment)) result.hasAttachment = ''; return result; }
export function routeAddress(input) { const route = normalizedRoute(input); const params = new URLSearchParams(); for (const [key, value] of Object.entries(route)) if (value && (key !== 'folder' || value !== 'inbox')) params.set(key, value); return 'browse' + (params.size ? '?' + params : ''); }
export function parseRoute(address) { if (!address || address === 'browse') return { ...EMPTY_ROUTE }; if (address.startsWith('conversation=')) return normalizedRoute({ id: address.slice(13) }); if (!address.includes('?') && /^[\w-]+$/.test(address) && address !== 'browse') return normalizedRoute({ id: address }); return normalizedRoute(Object.fromEntries(new URLSearchParams(address.startsWith('browse?') ? address.slice(7) : address.replace(/^\?/, '')))); }
export function localDayStart(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value; const [year, month, day] = value.split('-').map(Number); const checked = new Date(Date.UTC(year, month - 1, day)); if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) return value; return new Date(year, month - 1, day).toISOString(); }
export function feedQuery(route, cursor) { const value = normalizedRoute(route); const params = new URLSearchParams({ folder: value.folder, limit: '50' }); for (const key of ['mailbox', 'q', ...FILTER_KEYS]) if (value[key]) params.set(key, ['after', 'before'].includes(key) ? localDayStart(value[key]) : value[key]); if (cursor) params.set('cursor', cursor); return params; }
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
