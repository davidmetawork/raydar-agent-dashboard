import { FILTER_FIELDS, parseFilters, composeQuery, feedQuery, contacts, firstContact, chooseReplyMessage, fullContacts, contactLabel, displayText, mailboxAddresses, logicalMessages, rowParticipant, attachmentStatus, attachmentReason, messageDirection, splitQuotedText, errorMessage, requestGate, EMAIL_CSP } from './master-inbox-model.mjs';
import { createComposer } from './master-inbox-composer.mjs';
/* The route contract and every trust sentence come from master-inbox-route.js,
   the classic script the shell loads before this module. It is shared with the
   scripted employee tests and with slice 1's unit tests, so this page must not
   grow a second copy of either. */
const ROUTE = window.MasterInboxRoute;
const normalizedRoute = input => ROUTE.normalizeRoute(input);
const routeAddress = input => ROUTE.serializeRoute(input);
const folderLabel = folder => ROUTE.FOLDER_LABELS[folder] || folder;
const $ = id => document.getElementById(id);
const el = (tag, className = '', text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
const btn = (label, className, action) => { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
const date = value => { const item = new Date(value); return value && Number.isFinite(item.valueOf()) ? item.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded'; };
const shortDate = value => { const item = new Date(value); if (!value || !Number.isFinite(item.valueOf())) return '—'; const today = new Date(); return item.toDateString() === today.toDateString() ? item.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : item.toLocaleDateString([], { month: 'short', day: 'numeric', ...(item.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }); };
const number = value => value === null || value === undefined ? '—' : Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
let savedScope = {}; try { savedScope = JSON.parse(localStorage.getItem('raydar-master-inbox-scope') || '{}'); } catch {}
const state = { route: normalizedRoute({ ...savedScope, ...Object.fromEntries(new URLSearchParams(location.search)), ...ROUTE.parseRoute(String(location.hash || '').replace(/^#/, '')) }), rows: [], boxes: [], selected: new Set(), thread: null, cursor: null, hasMore: false, coverage: null, parsed: null, negativeEvidence: null, loaded: false, loading: false, restorePages: 1, currentScreen: '', screenSequence: 0, listScroll: 0, listFocus: null, refreshAt: null, actionBusy: false };
const gates = { feed: requestGate(), thread: requestGate() };
const box = id => state.boxes.find(item => item.id === id);
const boxLabel = id => box(id)?.principal || box(id)?.visible_addresses?.[0] || id || 'All mailboxes';
const scopeLabel = () => boxLabel(state.route.mailbox);
function rememberList() { try { sessionStorage.setItem('raydar-inbox-list:' + routeAddress({ ...state.route, id: '' }), JSON.stringify({ scroll: $('listScroll').scrollTop, pages: Math.max(1, Math.ceil(state.rows.length / 50)) })); } catch {} }
function recoverListPosition(route) { try { const saved = JSON.parse(sessionStorage.getItem('raydar-inbox-list:' + routeAddress({ ...route, id: '' })) || '{}'); state.listScroll = Math.max(0, Number(saved.scroll) || 0); state.restorePages = Math.min(20, Math.max(1, Number(saved.pages) || 1)); } catch {} }
const composer = createComposer({ $, el, btn, api, toast, mailboxes: () => state.boxes, context: () => ({ thread: state.thread, mailboxId: state.route.mailbox }), refresh: () => { loadFeed(); if (state.route.id) loadThread(state.route.id); }, onSent: showSendReceipt });

async function api(path, options = {}) {
  const response = await fetch('/api/master-inbox/' + path, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) { const error = new Error(data.error || 'request_failed'); error.code = data.error; error.detail = data.detail; error.draftId = data.draftId; error.status = response.status; throw error; }
  return data;
}
function toast(message, label, handler, duration = 7000) { $('toastText').textContent = message; $('toastAction').textContent = label || ''; $('toastAction').classList.toggle('hidden', !label); $('toastAction').onclick = handler || null; $('toast').classList.remove('hidden'); clearTimeout(window.__inboxToast); if (duration) window.__inboxToast = setTimeout(() => $('toast').classList.add('hidden'), duration); }
function notice(message, retry, error) { const host = $('notice'); host.replaceChildren(el('span', '', message)); host.className = 'notice' + (error ? ' error' : ''); if (retry) host.append(btn('Try again', 'button', retry)); if (error?.status === 401 || error?.status === 403) { const link = el('a', 'button', 'Sign in'); link.href = '/login?return_to=' + encodeURIComponent(location.origin + '/master-inbox#' + routeAddress(state.route)); link.target = '_top'; host.append(link); } }
const clearNotice = () => $('notice').classList.add('hidden');
function empty(host, title, detail, retry) { const node = el('div', 'empty-state'); node.append(el('h3', '', title), el('p', '', detail)); if (retry) node.append(btn('Try again', 'button', retry)); host.replaceChildren(node); }
function makeLink(node, route) { node.href = RaydarNav.href(routeAddress(route)); node.addEventListener('click', event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return; event.preventDefault(); state.listFocus = document.activeElement; state.listScroll = $('listScroll').scrollTop; rememberList(); navigate(route); }); return node; }
// "All Mail" is the one folder the store does not scope: no provider label
// matches it, so the rows include spam and trash and skip the snooze
// exclusion. The rail says so rather than letting the name imply otherwise.
const FOLDER_NOTES = { 'all-mail': 'Everything retained, including spam and trash.', all: 'Inbox mail across every mailbox in scope.', snoozed: 'Conversations you snoozed in Raydar, still due.' };
function renderFolders() { for (const host of [$('folders'), $('drawerFolders')]) { host.replaceChildren(); for (const id of ROUTE.FOLDERS) { const node = btn(folderLabel(id), 'view-button', () => { navigate({ ...state.route, folder: id, id: '' }); $('accountDrawer').close(); }); node.dataset.folder = id; if (FOLDER_NOTES[id]) node.title = FOLDER_NOTES[id]; if (state.route.folder === id) { node.classList.add('active'); node.setAttribute('aria-current', 'page'); } host.append(node); } } }
function renderAccounts() { for (const host of [$('mailbox'), $('drawerMailbox')]) { host.replaceChildren(); const all = el('option', '', 'All mailboxes'); all.value = ''; host.append(all); for (const mailbox of state.boxes) { const option = el('option', '', boxLabel(mailbox.id)); option.value = mailbox.id; host.append(option); } if (state.route.mailbox && !state.boxes.some(mailbox => mailbox.id === state.route.mailbox)) { const option = el('option', '', state.route.mailbox + ' (unavailable)'); option.value = state.route.mailbox; host.append(option); } host.value = state.route.mailbox; } composer.updateIdentities(); }
// The filter panel is a writer for the query string: every control below
// round-trips through `q`, so the address bar, the search box and the store
// all see the same query and no filter can be silently dropped.
const filters = () => parseFilters(state.route.q);
const withFilters = changes => ({ ...state.route, q: composeQuery({ ...filters(), ...changes }), id: '' });
function renderScope() {
  renderFolders();
  const active = filters();
  $('viewTitle').textContent = ROUTE.viewTitle(state.route.folder, state.route.mailbox ? scopeLabel() : '');
  $('scopeDescription').textContent = folderLabel(state.route.folder) + ' · ' + scopeLabel() + (FOLDER_NOTES[state.route.folder] ? ' · ' + FOLDER_NOTES[state.route.folder] : '');
  $('search').value = state.route.q;
  for (const key of FILTER_FIELDS) $('filter-' + key).value = active[key];
  $('filter-hasAttachment').checked = active.hasAttachment;
  $('mailbox').value = state.route.mailbox; $('drawerMailbox').value = state.route.mailbox;
  $('unreadShortcut').setAttribute('aria-pressed', String(active.unread));
  renderChips(active);
  document.body.classList.toggle('reading', Boolean(state.route.id));
  try { localStorage.setItem('raydar-master-inbox-scope', JSON.stringify({ folder: state.route.folder, mailbox: state.route.mailbox })); } catch {}
}
// One chip per active filter, beside the search box, each removable.
const CHIP_LABELS = { from: 'From', to: 'To', after: 'On or after', before: 'Before' };
function renderChips(active) {
  const host = $('filterChips'); host.replaceChildren();
  const chips = [];
  for (const key of FILTER_FIELDS) if (active[key]) chips.push([CHIP_LABELS[key] + ' ' + active[key], () => navigate(withFilters({ [key]: '' }))]);
  if (active.unread) chips.push(['Unread only', () => navigate(withFilters({ unread: false }))]);
  if (active.hasAttachment) chips.push(['Has attachment', () => navigate(withFilters({ hasAttachment: false }))]);
  for (const [label, clear] of chips) { const chip = btn(label + ' ×', 'filter-chip', clear); chip.setAttribute('aria-label', 'Remove filter ' + label); host.append(chip); }
  host.classList.toggle('hidden', !chips.length);
  $('filterCount').textContent = String(chips.length); $('filterCount').classList.toggle('hidden', !chips.length);
}
function navigate(input, { push = true, restoreScroll = false } = {}) {
  const next = normalizedRoute(input); const previous = { ...state.route }; const oldScreen = state.currentScreen; const scroll = $('listScroll').scrollTop; const focusID = state.route.id;
  const changedQuery = routeAddress({ ...next, id: '' }) !== routeAddress({ ...previous, id: '' }); const changedID = next.id !== previous.id;
  if (!changedQuery && !changedID && state.loaded) return;
  state.route = next;
  if (push) { const name = 'master-inbox-screen-' + (++state.screenSequence); state.currentScreen = name; RaydarNav.open(name, () => { state.currentScreen = oldScreen; state.listScroll = scroll; navigate(previous, { push: false, restoreScroll: true }); if (focusID) restoreRowFocus(focusID); }, routeAddress(next)); }
  clearNotice(); renderScope();
  if (changedQuery) { gates.feed.cancel(); state.rows = []; state.cursor = null; state.hasMore = false; state.selected.clear(); state.loaded = false; state.listScroll = 0; state.restorePages = 1; }
  if (changedID || changedQuery) { gates.thread.cancel(); state.thread = null; if (!next.id) $('reader').replaceChildren(); }
  if (changedQuery || !state.loaded) loadFeed(); else renderList();
  if (next.id && (changedID || changedQuery || !state.thread)) loadThread(next.id);
  if (restoreScroll) requestAnimationFrame(() => { $('listScroll').scrollTop = state.listScroll; });
}
function restoreRowFocus(id) { requestAnimationFrame(() => { const link = Array.from(document.querySelectorAll('.conversation-link')).find(node => node.dataset.id === id); link?.focus({ preventScroll: true }); }); }
function backToList() { const id = state.route.id; const scroll = state.listScroll; if (!RaydarNav.back(state.currentScreen)) navigate({ ...state.route, id: '' }, { push: false }); requestAnimationFrame(() => { $('listScroll').scrollTop = scroll; restoreRowFocus(id); }); }

function renderList() {
  const host = $('conversationList'); host.replaceChildren(); host.setAttribute('aria-busy', String(state.loading));
  // The empty state is a claim about absence, so it is written by the route
  // module from the store's negativeEvidence and cross-checked against the
  // per-mailbox history floor: "no conversations match, through 14:05" only
  // when every mailbox in scope is current AND fully imported.
  if (!state.rows.length && !state.loading) { const evidence = ROUTE.emptyStateText(state.coverage); const node = el('div', 'empty ' + evidence.tone); node.append(el('strong', '', evidence.headline), el('span', '', evidence.detail)); host.replaceChildren(node); }
  for (const row of state.rows) {
    const item = el('div', 'inbox-row' + (row.unread ? ' unread' : '') + (state.route.id === row.id ? ' active' : '')); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(row.id); checkbox.setAttribute('aria-label', 'Select ' + displayText(row.subject || 'conversation')); checkbox.addEventListener('change', () => { if (checkbox.checked && state.selected.size >= 25) { checkbox.checked = false; return toast('Select up to 25 conversations for one bulk action.'); } checkbox.checked ? state.selected.add(row.id) : state.selected.delete(row.id); renderBulk(); });
    const star = btn(row.starred ? '★' : '☆', 'star-button', () => action(row.starred ? 'unstar' : 'star', rowTargets(row))); star.setAttribute('aria-label', row.starred ? 'Remove star' : 'Add star'); star.setAttribute('aria-pressed', String(Boolean(row.starred))); star.disabled = !rowTargets(row).length || state.actionBusy;
    const link = makeLink(el('a', 'conversation-link'), { ...state.route, id: row.id }); link.dataset.id = row.id; if (state.route.id === row.id) link.setAttribute('aria-current', 'true'); const participant = el('span', 'participant', rowParticipant(row)); participant.title = fullContacts(row.last_direction === 'outbound' ? row.latest_to : row.latest_from) || rowParticipant(row); const copy = el('span', 'conversation-copy'); copy.append(el('span', 'subject', displayText(row.subject || '(No subject)') + (Number(row.message_count) > 1 ? ' · ' + row.message_count : '')), el('span', 'snippet', displayText(row.snippet || 'No preview available')));
    const when = el('time', 'row-time', shortDate(row.newest_at)); when.title = date(row.newest_at); const facts = el('span', 'row-facts'); const ids = row.matching_mailbox_ids?.length ? row.matching_mailbox_ids : row.mailbox_ids || []; const mailbox = el('span', 'row-mailbox', ids.map(boxLabel).join(' · ') || 'Mailbox not recorded'); mailbox.title = ids.map(boxLabel).join(', '); facts.append(el('span', 'direction ' + (row.last_direction || ''), messageDirection({ ...row, direction: row.last_direction })), mailbox);
    if (row.has_attachment) { const available = Number(row.attachments?.available || 0); facts.append(el('span', 'attachment-fact', available ? 'File available' : 'Attachment recorded')); }
    if (Number(row.message_copy_count) > Number(row.message_count)) facts.title = `${row.message_count} messages · ${row.message_copy_count} retained mailbox copies`;
    link.append(participant, copy, when, facts); item.append(checkbox, star, link); host.append(item);
  }
  $('loadMore').classList.toggle('hidden', !state.hasMore); $('loadMore').disabled = state.loading; $('listSummary').textContent = state.rows.length ? `${number(state.rows.length)} ${state.rows.length === 1 ? 'conversation' : 'conversations'} loaded${state.hasMore ? ' · more available' : ''} · ${scopeLabel()}` : '0 matching conversations'; renderBulk();
}
function renderBulk() { $('bulkToolbar').classList.toggle('hidden', !state.selected.size); $('selectedCount').textContent = `${state.selected.size} selected`; $('bulkRead').disabled = state.actionBusy; $('bulkArchive').disabled = state.actionBusy; }
async function loadFeed(append = false, restorePosition = null) {
  if (!append && state.loaded) state.listScroll = $('listScroll').scrollTop; const listPosition = restorePosition ?? (append ? $('listScroll').scrollTop : state.listScroll); const ticket = gates.feed.begin(); state.loading = true; $('conversationList').setAttribute('aria-busy', 'true'); $('loadMore').disabled = true; $('listSummary').textContent = append ? 'Loading more conversations…' : 'Updating conversations…'; if (!state.rows.length) empty($('conversationList'), 'Loading mail…', 'Reading retained messages and mailbox coverage.');
  try { const data = await api('feed?' + feedQuery(state.route, append ? state.cursor : null), { signal: ticket.signal }); if (!ticket.current()) return;
    const known = new Set(state.rows.map(row => row.id)); state.rows = append ? [...state.rows, ...(data.rows || []).filter(row => !known.has(row.id))] : data.rows || []; state.cursor = data.cursor || null; state.hasMore = Boolean(data.hasMore && state.cursor); state.boxes = data.mailboxStatus === 'unavailable' ? state.boxes : data.mailboxes || state.boxes; state.coverage = data.coverage || null; state.parsed = data.query || null; state.negativeEvidence = data.coverage?.negativeEvidence || null; state.refreshAt = new Date(); state.loaded = true; state.loading = false; clearNotice(); renderAccounts(); renderScope(); renderCounts(); renderList(); renderStatus(); renderSearchNotice(); renderCoverage();
    if (data.mailboxStatus === 'unavailable') notice('Messages loaded, but account settings and coverage could not be refreshed. Sending identities may be unavailable.', () => loadFeed());
    if (state.restorePages > 1 && state.hasMore) { state.restorePages--; await loadFeed(true, listPosition); } else { state.restorePages = 1; $('listScroll').scrollTop = listPosition; }
    // These counts are retained unread mailbox copies, not conversations or work.
    const unread = state.boxes.reduce((sum, mailbox) => sum + Number(mailbox.unread_count || 0), 0); parent.postMessage({ type: 'raydar-master-inbox-counts', unread, unit: 'retained_message_copies' }, location.origin);
  } catch (error) { if (!ticket.current() || error.name === 'AbortError') return; state.loading = false; $('conversationList').setAttribute('aria-busy', 'false'); $('loadMore').disabled = false; const pill = $('status'); pill.className = 'status unknown'; pill.textContent = state.loaded ? 'Not refreshed · earlier records remain visible' : 'Coverage unknown · mail could not be loaded'; pill.title = 'This read did not complete, so nothing on screen can be treated as current.'; const searchError = String(error.code).startsWith('search_'); if (searchError) { state.rows = []; state.cursor = null; state.hasMore = false; $('loadMore').classList.add('hidden'); empty($('conversationList'), 'Search needs attention', errorMessage(error)); } else if (!state.rows.length) empty($('conversationList'), 'Mail is unavailable', 'This is a loading failure, not an empty mailbox.', () => loadFeed()); notice(errorMessage(error) + (state.rows.length ? ' Previously loaded records remain visible.' : ''), searchError ? null : () => loadFeed(append), error); $('listSummary').textContent = searchError ? 'Search not applied' : 'Refresh not confirmed'; }
}
// The status pill, the empty state and the search notice are all derived from
// the store's own coverage object by master-inbox-route.js. Nothing on this
// page is allowed to compose a freshness sentence of its own: "current" is a
// claim, and only the store can make it.
function renderStatus() {
  const summary = ROUTE.coverageSummary(state.coverage, { label: boxLabel });
  const pill = $('status');
  pill.className = 'status ' + summary.tone;
  pill.textContent = summary.text;
  pill.title = summary.detail;
}
function renderCounts() {
  const shown = state.route.mailbox ? state.boxes.filter(mailbox => mailbox.id === state.route.mailbox) : state.boxes;
  const unread = shown.reduce((sum, mailbox) => sum + Number(mailbox.unread_count || 0), 0);
  const inbox = shown.reduce((sum, mailbox) => sum + Number(mailbox.inbox_count || 0), 0);
  // Units, always: these are retained MESSAGE COPIES in the store, not
  // conversations and not work remaining. An unlabelled 153,480 reads as a
  // backlog; "153,480 unread messages" reads as what it is.
  const reportsInbox = shown.some(mailbox => mailbox.inbox_count !== null && mailbox.inbox_count !== undefined);
  const parts = shown.length ? [`${number(unread)} unread ${unread === 1 ? 'message' : 'messages'}`] : [];
  if (reportsInbox) parts.push(`${number(inbox)} retained inbox ${inbox === 1 ? 'message' : 'messages'}`);
  if (shown.length) parts.push(`${shown.length} ${shown.length === 1 ? 'mailbox' : 'mailboxes'}`);
  const host = $('scopeCounts');
  host.textContent = parts.join(' · ');
  host.title = 'Counts are retained message copies in the shared store, not conversations and not unfinished work.';
}
function renderCoverage() {
  const coverage = state.coverage;
  const scoped = ROUTE.scopedMailboxes(coverage);
  const incomplete = ROUTE.incompleteHistory(coverage);
  $('coverageSummary').textContent = coverage
    ? `Mailbox coverage · ${scoped.length} in scope${incomplete.length ? ` · ${incomplete.length} still importing history` : ''}`
    : 'Mailbox coverage · not reported with this result';
  const host = $('coverageDetails'); host.replaceChildren();
  host.append(el('p', '', 'Recent sync and full-history import are separate facts. A mailbox synced a minute ago can still be missing years of older mail, so an empty result is only ever as strong as the weaker of the two.'));
  if (!scoped.length) { host.append(el('p', '', 'The store reported no per-mailbox coverage with this result, so mailbox freshness and historical completeness are unknown.')); return; }
  const table = el('table', 'coverage-table'); const header = el('tr');
  for (const label of ['Mailbox', 'Status', 'Synced through', 'Behind by', 'History import', 'Oldest retained']) header.append(el('th', '', label));
  const head = el('thead'); head.append(header); table.append(head);
  const body = el('tbody');
  for (const mailbox of scoped) {
    const row = el('tr');
    const account = el('td', '', mailbox.principal || boxLabel(mailbox.id));
    const status = el('td', '', displayText(String(mailbox.status || 'unknown').replaceAll('_', ' ')));
    if (mailbox.lastErrorClass) status.append(el('small', '', 'Last error: ' + String(mailbox.lastErrorClass).replaceAll('_', ' ')));
    const synced = el('td', '', mailbox.syncedThrough ? date(mailbox.syncedThrough) : 'Never completed a sync');
    const lag = el('td', '', mailbox.lagSeconds === null || mailbox.lagSeconds === undefined ? 'Unknown' : `${number(mailbox.lagSeconds)} seconds`);
    const history = el('td', '', ({ complete: 'Complete', partial: 'Partial', none: 'Not started' })[mailbox.history?.importState] || 'Unreported');
    const oldest = el('td', '', mailbox.history?.oldestAt ? date(mailbox.history.oldestAt) : 'Not recorded');
    row.append(account, status, synced, lag, history, oldest); body.append(row);
  }
  table.append(body); const scroll = el('div', 'coverage-scroll'); scroll.append(table); host.append(scroll);
  const evidence = coverage?.negativeEvidence;
  if (evidence?.reason) host.append(el('p', 'coverage-evidence', 'What an empty result would mean here: ' + evidence.reason));
}
function renderSearchNotice() {
  const text = ROUTE.searchNotice(state.parsed);
  const host = $('searchNotice');
  host.textContent = text;
  host.classList.toggle('hidden', !text);
}

function safePreviewHTML(value) {
  const template = document.createElement('template'); template.innerHTML = String(value || ''); template.content.querySelectorAll('script,iframe,frame,frameset,object,embed,base,meta,link,form,input,button,textarea,select,video,audio,source,track,svg,math,template').forEach(node => node.remove()); const resources = /[\\@]|(?:url|image|image-set|cross-fade)\s*\(/i; template.content.querySelectorAll('style').forEach(node => { if (resources.test(node.textContent)) node.remove(); }); template.content.querySelectorAll('*').forEach(node => { for (const attribute of [...node.attributes]) { const name = attribute.name.toLowerCase(); if (name.startsWith('on') || ['href', 'xlink:href', 'action', 'formaction', 'target', 'ping', 'srcdoc', 'srcset', 'autofocus', 'contenteditable', 'background', 'poster'].includes(name) || name === 'style' && resources.test(attribute.value) || name === 'src' && (node.tagName !== 'IMG' || !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value))) node.removeAttribute(attribute.name); } });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.6 Arial,sans-serif;margin:15px;overflow-wrap:anywhere}img,table{max-width:100%}pre{white-space:pre-wrap}a{pointer-events:none;color:inherit}</style></head><body>${template.innerHTML}</body></html>`;
}
function pair(list, label, value) { list.append(el('dt', '', label), el('dd', '', value || 'Not recorded')); }
function messageBody(message) {
  const host = el('div', 'message-body'); const split = splitQuotedText(message.safe_text); if (split.body || split.quoted) { host.append(el('pre', 'email-text', split.body)); if (split.quoted) { const quoted = el('details', 'quoted-text'); quoted.append(el('summary', '', 'Show quoted message text'), el('pre', '', split.quoted)); host.append(quoted); } } else host.append(el('p', 'detail-muted', message.safe_html ? 'This message has a stored HTML version.' : 'Message body unavailable in the retained record.'));
  if (message.safe_html) { const preview = el('div', 'html-host hidden'); const toggle = btn('Show isolated HTML preview', 'text-button', () => { const opening = preview.classList.contains('hidden'); preview.classList.toggle('hidden', !opening); toggle.textContent = opening ? 'Hide HTML preview' : 'Show isolated HTML preview'; if (opening && !preview.children.length) { const frame = el('iframe'); frame.title = 'Isolated email preview'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.srcdoc = safePreviewHTML(message.safe_html); preview.append(frame, el('p', 'body-note', 'Remote images, links, and active content are disabled.')); } }); host.append(toggle, preview); }
  return host;
}
function fileView(file, source = 'gmail') { const status = attachmentStatus(file); const ready = status === 'Available' && file.id; const node = el(ready ? 'a' : 'div', 'message-file'); if (ready) { node.href = file.downloadPath?.startsWith('/api/master-inbox/') ? file.downloadPath : '/api/master-inbox/' + (['draft', 'local_draft', 'local_send'].includes(source) ? 'draft-attachment' : 'attachment') + '?id=' + encodeURIComponent(file.id); node.target = '_blank'; node.rel = 'noopener'; } const name = el('span', '', file.filename || 'Attachment'); name.append(el('small', '', [file.size_bytes || file.sizeBytes ? number(Math.ceil((file.size_bytes || file.sizeBytes) / 1024)) + ' KB' : '', attachmentReason(file) || (status === 'Importing' ? 'The file is still being copied into the shared store.' : status === 'Available' ? 'Stored file available' : 'A downloadable file is not available.')].filter(Boolean).join(' · '))); node.append(name, el('span', 'badge ' + (ready ? 'delivered' : 'queued'), status)); return node; }
function readToolbar(thread) {
  const bar = el('div', 'read-toolbar'); bar.append(btn('← Back', 'back-button', backToList)); const targets = threadTargets(); const normal = !thread.recordType && Boolean(chooseReplyMessage(thread, state.route.mailbox));
  if (normal) { bar.append(btn('Reply', 'compose-button', () => composer.open('reply')), btn('Reply all', 'button', () => composer.open('reply-all'))); }
  if (thread.recordType === 'draft') bar.append(btn('Edit draft', 'compose-button', () => composer.open('edit')));
  else if (thread.messages?.at(-1)?.direction === 'draft') bar.append(btn('Continue draft', 'compose-button', () => composer.open('continue-draft')));
  if (thread.recordType === 'send' && ['held', 'scheduled'].includes(thread.sendState)) bar.append(btn('Cancel send', 'button', () => cancelSend(thread.id)));
  if (targets.length) bar.append(btn(['spam', 'trash'].includes(state.route.folder) ? 'Restore' : 'Archive', 'button', () => action(['spam', 'trash'].includes(state.route.folder) ? 'restore' : 'archive')));
  const more = el('details', 'toolbar-more'); more.append(el('summary', '', 'More')); const menu = el('div'); if (normal) menu.append(btn('Forward…', '', () => { more.open = false; composer.open('forward'); })); if (targets.length) for (const [label, actionName] of [['Mark unread', 'unread'], ['Star', 'star'], ['Move to spam', 'spam'], ['Move to trash', 'trash']]) menu.append(btn(label, '', () => { more.open = false; action(actionName); })); if (!thread.recordType) { menu.append(btn('Add a tag…', '', () => { more.open = false; organize('tag'); }), btn('Snooze…', '', () => { more.open = false; organize('snooze'); })); } menu.append(btn('Copy conversation link', '', () => { const url = new URL(RaydarNav.href(routeAddress(state.route)), location.origin).href; navigator.clipboard.writeText(url).then(() => toast('Conversation link copied.')).catch(() => toast('Copy the conversation URL from your browser.')); }), btn('Print', '', () => window.print())); more.append(menu); bar.append(more); return bar;
}
function renderThread() {
  const thread = state.thread; if (!thread) return; const host = $('reader'); host.replaceChildren(readToolbar(thread)); const content = el('div', 'reader-content'); content.append(el('h2', 'message-subject', displayText(thread.subject || '(No subject)'))); const messages = logicalMessages(thread.messages || []); content.append(el('p', 'thread-context', `${messages.length} known messages · ${(thread.messages || []).length} retained copies · ${scopeLabel()}`));
  if (thread.incomplete || Number(thread.missing_parent_count)) content.append(el('p', 'thread-warning', Number(thread.missing_parent_count) ? `${thread.missing_parent_count} referenced earlier message${Number(thread.missing_parent_count) === 1 ? ' is' : 's are'} not present. The known messages remain available.` : 'Some conversation history is missing or still being imported.'));
  if (state.coverage?.mailboxes?.some(item => item.history?.importState !== 'complete' && (thread.messages || []).some(message => message.mailbox_id === item.id))) content.append(el('p', 'thread-warning', 'One or more mailboxes in this conversation has an unfinished history import. See mailbox coverage below.'));
  const tags = el('div'); for (const entry of thread.userState || []) if (entry.kind === 'tag') tags.append(el('span', 'tag-chip', entry.value)); else if (entry.kind === 'snooze' && new Date(entry.due_at) > new Date()) tags.append(el('span', 'tag-chip', 'Snoozed until ' + date(entry.due_at))); content.append(tags);
  messages.forEach((message, index) => { const wrapper = el(index === messages.length - 1 ? 'section' : 'details', 'thread-message'); const heading = el(index === messages.length - 1 ? 'div' : 'summary'); const top = el('div', 'message-top'); const sender = firstContact(message.from_json) || {}; const label = el('strong', 'message-sender', fullContacts(message.from_json) || 'Sender not recorded'); const direction = messageDirection(message); label.append(el('small', '', direction + ' · ' + [...new Set(message.copies.map(copy => boxLabel(copy.mailbox_id)))].join(' · ') + (message.delivery_status && !['held', 'queued', 'releasing', 'failed', 'parked', 'pending', 'scheduled', 'cancelled', 'draft'].includes(message.delivery_status) ? ' · ' + String(message.delivery_status).replaceAll('_', ' ') : ''))); top.append(el('span', 'avatar', contactLabel([sender]).slice(0, 1).toUpperCase()), label, el('time', '', shortDate(message.internal_date))); top.title = date(message.internal_date); heading.append(top); wrapper.append(heading);
    const addresses = el('dl', 'message-addresses'); pair(addresses, 'From', fullContacts(message.from_json)); pair(addresses, 'To', fullContacts(message.to_json)); if (contacts(message.cc_json).length) pair(addresses, 'Cc', fullContacts(message.cc_json)); if (contacts(message.bcc_json).length) pair(addresses, 'Bcc', fullContacts(message.bcc_json)); if (contacts(message.reply_to_json).length) pair(addresses, 'Reply-To', fullContacts(message.reply_to_json)); pair(addresses, 'Date', date(message.internal_date)); wrapper.append(addresses, messageBody(message));
    const files = el('div', 'message-files'); for (const attachment of message.attachments || []) files.append(fileView(attachment, thread.recordType ? 'draft' : message.source || 'gmail')); if (message.attachments_status === 'unavailable' || message.attachment_metadata === 'unavailable') files.append(el('p', 'detail-muted', 'Attachment history is unavailable for this source record.')); wrapper.append(files); if (['local_send'].includes(message.source) && message.send_state === 'held') wrapper.append(btn('Cancel held send', 'button', () => cancelSend(message.id))); if (message.delivery_evidence?.deliveryCoverage === 'at_least_one_recipient') wrapper.append(el('p', 'delivery-explanation', 'Delivery is confirmed for at least one recipient. Delivery to all recipients has not been confirmed.')); else if (message.delivery_status === 'accepted') wrapper.append(el('p', 'delivery-explanation', 'The email provider accepted this message. Delivery has not been confirmed.')); if (message.delivery_status === 'delivered' && message.delivery_evidence?.deliveryCoverage !== 'at_least_one_recipient') wrapper.append(el('p', 'delivery-explanation', 'The recipient’s mail server confirmed delivery. This does not confirm the person read it.')); const metadata = el('details', 'message-metadata'); metadata.append(el('summary', '', `${message.copies.length} retained cop${message.copies.length === 1 ? 'y' : 'ies'} · message records`)); const records = el('div'); for (const copy of message.copies) records.append(el('p', '', `${boxLabel(copy.mailbox_id)} · ${copy.source || (copy.provider_message_id ? 'mailbox provider' : 'Raydar record')} · ${copy.provider_message_id || copy.id}`)); if (message.rfc_message_id) records.append(el('p', '', 'Message-ID: ' + message.rfc_message_id)); if (message.in_reply_to) records.append(el('p', '', 'In reply to: ' + message.in_reply_to)); if (message.body_source) records.append(el('p', '', 'Body source: ' + String(message.body_source).replaceAll('_', ' '))); metadata.append(records); wrapper.append(metadata); if (message.direction !== 'draft' && !(['local_send', 'mailroom'].includes(message.source) && ['held', 'queued', 'releasing', 'failed', 'parked', 'pending'].includes(message.send_state))) { const actions = el('div', 'message-options'); actions.append(btn('Reply to this message', '', () => composer.open('reply', message)), btn('Reply all', '', () => composer.open('reply-all', message)), btn('Forward…', '', () => composer.open('forward', message))); if (message.provider_message_id && message.raw_available !== false) { const download = el('a', 'text-button', 'Download message'); download.href = '/api/master-inbox/message-export?id=' + encodeURIComponent(message.id); download.target = '_blank'; download.rel = 'noopener'; actions.append(download); } wrapper.append(actions); } content.append(wrapper);
  });
  for (const note of thread.coverage?.notes || []) content.append(el('p', 'detail-muted', typeof note === 'string' ? note : note.message || 'Some history is unavailable.')); host.append(content);
}
async function loadThread(id) { const ticket = gates.thread.begin(); empty($('reader'), 'Loading conversation…', 'Fetching known messages and attachment status.'); try { const data = await api('thread?id=' + encodeURIComponent(id), { signal: ticket.signal }); if (!ticket.current() || state.route.id !== id) return; state.thread = data.conversation; if (!state.thread) throw new Error('conversation_unavailable'); renderThread(); $('readerPane').scrollTop = 0; const row = state.rows.find(item => item.id === id); if (row?.unread && rowTargets(row).length) action('read', rowTargets(row), { quiet: true }); } catch (error) { if (!ticket.current() || error.name === 'AbortError') return; const host = $('reader'); host.replaceChildren(btn('← Back', 'button', backToList)); const detail = el('div'); empty(detail, 'Conversation unavailable', errorMessage(error), () => loadThread(id)); host.append(detail); } }
function rowTargets(row) { const targets = row.action_targets || (row.action_target ? [row.action_target] : []); return targets.filter(target => !state.route.mailbox || target.mailboxId === state.route.mailbox); }
function threadTargets() { const seen = new Set(); return (state.thread?.messages || []).filter(message => message.provider_action_eligible !== false && message.action_target && (!state.route.mailbox || message.mailbox_id === state.route.mailbox)).map(message => message.action_target).filter(target => { const key = target.mailboxId + ':' + target.providerMessageId; if (!target.mailboxId || !target.providerMessageId || seen.has(key)) return false; seen.add(key); return true; }); }
async function action(kind, targets = threadTargets(), { quiet = false } = {}) { if (!targets.length) return false; if (state.actionBusy) { if (!quiet) toast('Another mailbox action is still being confirmed. Try again when it finishes.'); return false; } state.actionBusy = true; renderBulk(); try { const data = await api('action', { method: 'POST', body: JSON.stringify({ targets, action: kind, idempotencyKey: crypto.randomUUID() }) }); if (data.state === 'repair') { if (!quiet) toast('At least one mailbox copy could not be confirmed. Refresh before trying again.'); return false; } if (!quiet) toast(`${kind.charAt(0).toUpperCase() + kind.slice(1)} confirmed for the selected mailbox copies.`); if (!quiet) await loadFeed(); return true; } catch (error) { if (!quiet) toast(errorMessage(error)); return false; } finally { state.actionBusy = false; renderBulk(); } }
async function bulk(kind) { const rows = state.rows.filter(row => state.selected.has(row.id)); let confirmed = 0; for (const row of rows) if (await action(kind, rowTargets(row), { quiet: true })) confirmed++; toast(`${confirmed} of ${rows.length} conversation actions confirmed. Scope: ${scopeLabel()}.`); state.selected.clear(); await loadFeed(); }
let organizeKind = 'tag';
function organize(kind) { if (!state.thread) return; organizeKind = kind; $('organizeTitle').textContent = kind === 'tag' ? 'Add a tag' : 'Snooze conversation'; $('organizeLabel').textContent = kind === 'tag' ? 'Tag name' : 'Return to Snoozed until'; $('organizeValue').type = kind === 'tag' ? 'text' : 'datetime-local'; $('organizeValue').value = ''; $('organizeNote').textContent = kind === 'tag' ? 'Tags are shared Raydar labels for this conversation.' : 'Saved in Raydar. Times use ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '.'; $('organizeDialog').showModal(); $('organizeValue').focus(); }
$('organizeForm').addEventListener('submit', async event => { event.preventDefault(); const value = $('organizeValue').value.trim(); if (organizeKind === 'report') { try { const result = await api('report', { method: 'POST', body: JSON.stringify({ conversationId: state.thread?.id || null, note: value, context: { folder: state.route.folder, mailbox: state.route.mailbox, query: state.route.q } }) }); $('organizeDialog').close(); toast('Problem report saved' + (result.report?.id ? ' · reference ' + result.report.id : '') + '.'); } catch (error) { $('organizeNote').textContent = errorMessage(error); } return; } if (!value || !state.thread) return; if (organizeKind === 'snooze' && new Date(value) <= new Date()) { $('organizeNote').textContent = 'Choose a future time.'; return; } try { await api('action', { method: 'POST', body: JSON.stringify({ scope: 'raydar', conversationId: state.thread.id, kind: organizeKind, value: organizeKind === 'tag' ? value : '', dueAt: organizeKind === 'snooze' ? new Date(value).toISOString() : null }) }); $('organizeDialog').close(); await loadThread(state.route.id); toast(organizeKind === 'tag' ? 'Tag saved in Raydar.' : 'Snooze saved in Raydar.'); } catch (error) { $('organizeNote').textContent = errorMessage(error); } });
let receiptTimer;
async function cancelSend(id) { try { await api('send', { method: 'POST', body: JSON.stringify({ action: 'cancel', sendId: id }) }); clearInterval(receiptTimer); $('sendReceipt').replaceChildren(el('span', '', 'Send cancelled. The email was not released by this send request.')); $('sendReceipt').classList.remove('hidden'); toast('Send cancelled.'); loadFeed(); } catch (error) { toast('Cancellation was not confirmed. The send may already have been released.'); } }
function showSendReceipt(data) {
  clearInterval(receiptTimer); const host = $('sendReceipt'); const text = el('span'); const scheduled = data.scheduledFor || data.scheduled_for; const until = Date.parse(data.undoUntil || data.holdUntil || '');
  const undo = btn(scheduled ? 'Cancel scheduled send' : 'Undo send', 'button', () => cancelSend(data.id)); const close = btn('×', 'text-button', () => { host.classList.add('hidden'); clearInterval(receiptTimer); }); close.setAttribute('aria-label', 'Dismiss send status'); host.replaceChildren(text, undo, close); host.classList.remove('hidden');
  function tick() {
    const left = Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : null;
    if (data.state && data.state !== 'held') { text.textContent = ({ queued: 'Queued for email delivery. Check Sent for delivery updates.', releasing: 'The send outcome is being confirmed. Check Sent before starting another send.', cancelled: 'This send was cancelled.', failed: 'This send failed. Check Sent for details.', parked: 'This send needs review. Check Sent for details.', delivered: 'Delivery was recorded. Check Sent for recipient details.' })[data.state] || 'Send request recorded. Check Sent for the current outcome.'; undo.disabled = true; clearInterval(receiptTimer); }
    else if (scheduled && Date.parse(scheduled) > Date.now()) text.textContent = 'Scheduled for ' + date(scheduled) + ' · ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
    else if (left > 0) text.textContent = `Send held · ${left}s remaining to undo`;
    else { text.textContent = 'The hold has ended. Check Sent for the recorded send outcome.'; undo.disabled = true; clearInterval(receiptTimer); }
  }
  tick(); if (!scheduled && (!data.state || data.state === 'held')) receiptTimer = setInterval(tick, 250);
}

for (const host of [$('mailbox'), $('drawerMailbox')]) host.addEventListener('change', () => { navigate({ ...state.route, mailbox: host.value, id: '' }); if ($('accountDrawer').open) $('accountDrawer').close(); });
$('openAccounts').onclick = () => { $('accountDrawer').showModal(); $('drawerMailbox').focus(); }; $('closeAccounts').onclick = () => $('accountDrawer').close();
$('filterToggle').onclick = () => { const open = $('filterToggle').getAttribute('aria-expanded') !== 'true'; $('filterToggle').setAttribute('aria-expanded', String(open)); $('filters').classList.toggle('hidden', !open); };
for (const key of FILTER_FIELDS) $('filter-' + key).addEventListener('change', () => navigate(withFilters({ [key]: $('filter-' + key).value.trim() })));
$('filter-hasAttachment').addEventListener('change', () => navigate(withFilters({ hasAttachment: $('filter-hasAttachment').checked })));
$('clearFilters').onclick = () => navigate(withFilters({ from: '', to: '', after: '', before: '', unread: false, hasAttachment: false }));
$('unreadShortcut').onclick = () => navigate(withFilters({ unread: !filters().unread }));
let searchTimer; const search = () => { clearTimeout(searchTimer); navigate({ ...state.route, q: $('search').value.trim(), id: '' }); }; $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 400); }); $('searchForm').onsubmit = event => { event.preventDefault(); search(); };
$('refresh').onclick = () => { loadFeed(); if (state.route.id) loadThread(state.route.id); }; $('loadMore').onclick = () => { if (!state.loading) loadFeed(true); }; $('compose').onclick = () => composer.open('new'); $('bulkRead').onclick = () => bulk('read'); $('bulkArchive').onclick = () => bulk('archive'); $('clearSelection').onclick = () => { state.selected.clear(); renderList(); }; $('toastClose').onclick = () => $('toast').classList.add('hidden'); $('closeOrganize').onclick = () => $('organizeDialog').close();
$('reportProblem').onclick = () => { organizeKind = 'report'; $('organizeTitle').textContent = 'Report a problem'; $('organizeLabel').textContent = 'What looked wrong?'; $('organizeValue').type = 'text'; $('organizeValue').value = ''; $('organizeNote').textContent = 'The report includes the current mailbox, folder, search, and conversation reference.'; $('organizeDialog').showModal(); $('organizeValue').focus(); };
document.addEventListener('keydown', event => { if (document.querySelector('dialog[open]')) return; const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName); if (typing) return; if (event.key === '/' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); $('search').focus(); } if (event.key === 'Escape' && state.route.id) { event.preventDefault(); backToList(); } if (['ArrowDown', 'ArrowUp'].includes(event.key) && document.activeElement?.classList.contains('conversation-link')) { const links = [...document.querySelectorAll('.conversation-link')]; const index = links.indexOf(document.activeElement); const next = links[index + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) { event.preventDefault(); next.focus(); } } });
$('dateHint').textContent = 'Company and role names search stored message text. Dates are calendar days (YYYY-MM-DD) read by the store in UTC, not in ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '.';
window.addEventListener('pagehide', rememberList);
function boot() {
  let restored = false;
  RaydarNav.restore(address => { restored = true; const target = ROUTE.parseRoute(address); state.route = { ...target, id: '' }; recoverListPosition(target); renderScope(); navigate(target); });
  if (!restored) { recoverListPosition(state.route); renderScope(); loadFeed(); if (state.route.id) loadThread(state.route.id); }
}
// Fail closed, and say why. Inside the shell iframe the durable session is
// already there and the gate never appears; at a bookmarked or copied
// conversation link this is what stands between an employee and a feed request
// that would only fail with a 401 further down.
function showGate(message) { $('gate').classList.remove('hidden'); $('gateError').textContent = message || ''; }
async function start() {
  let config = {};
  try { config = await fetch('/api/seq/config', { cache: 'no-store' }).then(response => response.json()); } catch {}
  if (!config.authRequired) return showGate('Google sign-in is not configured, so Master Inbox is fail-closed.');
  const session = await window.RaydarAuth?.session().catch(() => null);
  if (session?.authenticated) return boot();
  showGate('');
  // Google's script is loaded ONLY when the gate is actually shown. Every
  // employee loads this page inside the shell iframe, where the session
  // already exists, so a static <script src="accounts.google.com"> would be a
  // third-party fetch on every page view that can never be used.
  const render = () => {
    if (!(window.google && google.accounts?.id)) return setTimeout(render, 150);
    google.accounts.id.initialize({ client_id: config.googleClientId, callback: async response => {
      try { await window.RaydarAuth.signIn(response.credential); $('gate').classList.add('hidden'); boot(); }
      catch { $('gateError').textContent = 'Sign-in failed — try again.'; }
    } });
    google.accounts.id.renderButton($('gsi'), { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill' });
  };
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.onerror = () => { $('gateError').textContent = 'The Google sign-in script could not be loaded. Open monitor.raydar.xyz and sign in there, then reload this page.'; };
  script.onload = render;
  document.head.append(script);
}
start();
