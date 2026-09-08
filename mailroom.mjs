import { VIEWS, DELIVERY_LABELS, EMPTY_FILTERS, normalizeFilters, stateAddress, addressState, listQuery, displayNumber, statusKey, statusExplanation, wrapSafeEmailHTML, createRequestGate, mergeMessageRows, lanePurpose } from './mailroom-model.mjs';

const $ = id => document.getElementById(id);
const state = { filters: normalizeFilters(Object.fromEntries(new URLSearchParams(location.search))), rows: [], nextCursor: null, message: null, lanes: [], senders: [], counts: null, listCoverage: null, laneCoverage: null, loadedAt: null, listLoading: false, lanesLoaded: false, currentScreen: '', screenSequence: 0, bodyMode: 'text' };
const gates = { list: createRequestGate(), message: createRequestGate(), lanes: createRequestGate() };
const emptyReader = $('reader').cloneNode(true);
const node = (tag, className = '', value) => { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) element.textContent = String(value); return element; };
const button = (label, className, action) => { const element = node('button', className, label); element.type = 'button'; element.addEventListener('click', action); return element; };
const safeArray = value => Array.isArray(value) ? value : [];
const fullDate = value => { if (!value) return 'Not recorded'; const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded'; };
const shortDate = value => { if (!value) return '—'; const date = new Date(value); if (!Number.isFinite(date.valueOf())) return '—'; const today = new Date(); return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }); };
const rowDate = row => row.sort_at || row.sent_at || row.created_at;
const recipient = row => row.to_name || row.to_email || 'Recipient not recorded';
const laneLabel = row => row.lane_name || row.lane_id || 'Lane not recorded';
const activeFilterCount = () => ['lane', 'sender', 'delivery', 'from', 'to'].filter(key => state.filters[key]).length;

function badge(row) {
  const status = statusKey(row);
  const element = node('span', 'badge ' + status, DELIVERY_LABELS[status]);
  element.title = statusExplanation(row);
  return element;
}

function routeLink(element, next) {
  element.href = window.RaydarNav?.href(stateAddress(next)) || '/mailroom#' + stateAddress(next);
  element.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
    event.preventDefault(); navigate(next);
  });
  return element;
}

async function request(query, ticket) {
  const response = await fetch('/api/mailroom/browser?' + query.toString(), { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: ticket.signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? 'Sign in to view Mailroom emails.' : 'Mailroom could not load these records. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function showNotice(message, { retry, error = false, auth = false } = {}) {
  const host = $('notice'); host.replaceChildren(node('span', '', message)); host.className = 'notice' + (error ? ' error' : '');
  if (auth) {
    const link = node('a', 'button', 'Sign in');
    link.href = '/login?return_to=' + encodeURIComponent(location.origin + '/mailroom#' + stateAddress(state.filters)); link.target = '_top'; host.append(link);
  } else if (retry) host.append(button('Try again', 'button', retry));
}

function clearNotice() { $('notice').classList.add('hidden'); }
function announceFreshness() { $('freshness').textContent = state.loadedAt ? 'Updated ' + state.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Connecting…'; }

function renderControls() {
  document.querySelectorAll('[data-view]').forEach(element => { const selected = element.dataset.view === state.filters.view; element.classList.toggle('active', selected); if (selected) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current'); });
  for (const key of ['q', 'lane', 'sender', 'delivery', 'from', 'to']) { const element = $(key === 'q' ? 'search' : key); if (element.value !== state.filters[key]) element.value = state.filters[key]; }
  const isLanes = state.filters.view === 'lanes';
  $('mailPanes').classList.toggle('hidden', isLanes); $('lanesPane').classList.toggle('hidden', !isLanes); $('searchForm').classList.toggle('hidden', isLanes);
  const showFilters = !isLanes && (activeFilterCount() > 0 || $('filterToggle').getAttribute('aria-expanded') === 'true');
  $('filters').classList.toggle('hidden', !showFilters); $('filterToggle').setAttribute('aria-expanded', String(showFilters));
  $('filterCount').textContent = String(activeFilterCount()); $('filterCount').classList.toggle('hidden', activeFilterCount() === 0);
  $('viewTitle').textContent = VIEWS[state.filters.view];
  document.body.classList.toggle('reading', Boolean(state.filters.id) && !isLanes);
  document.querySelectorAll('[data-count]').forEach(element => { element.textContent = displayNumber(state.counts?.[element.dataset.count]); element.title = 'Matches current email filters'; });
}

function restoreReaderEmpty() { $('reader').replaceChildren(...Array.from(emptyReader.childNodes).map(element => element.cloneNode(true))); }

function navigate(filters, { push = true } = {}) {
  const next = normalizeFilters(filters);
  const previous = { ...state.filters };
  const previousScreen = state.currentScreen;
  const queryChanged = stateAddress({ ...previous, id: '' }) !== stateAddress({ ...next, id: '' });
  const messageChanged = previous.id !== next.id;
  if (!queryChanged && !messageChanged && state.loadedAt) return;
  state.filters = next;
  if (push && window.RaydarNav) {
    const screen = 'mailroom-screen-' + (++state.screenSequence);
    state.currentScreen = screen;
    window.RaydarNav.open(screen, () => { state.currentScreen = previousScreen; navigate(previous, { push: false }); }, stateAddress(next));
  }
  clearNotice(); renderControls();
  if (queryChanged) { gates.list.cancel(); state.rows = []; state.nextCursor = null; state.counts = null; renderControls(); }
  if (messageChanged || queryChanged) { gates.message.cancel(); state.message = null; if (!next.id) restoreReaderEmpty(); }
  if (next.view === 'lanes') { gates.list.cancel(); renderLanes(); if (!state.lanesLoaded) loadLanes(); }
  else if (queryChanged || !state.loadedAt || !state.rows.length) loadList();
  if (next.id && next.view !== 'lanes' && (messageChanged || queryChanged || !state.message)) loadMessage(next.id);
  renderSelection(); renderCoverage();
}

function renderSelection() { document.querySelectorAll('.email-row').forEach(element => { const active = element.dataset.id === state.filters.id; element.classList.toggle('active', active); if (active) element.setAttribute('aria-current', 'true'); else element.removeAttribute('aria-current'); }); }

function renderSkeleton(host) {
  const wrap = node('div', 'loading-rows'); wrap.setAttribute('aria-label', 'Loading emails');
  for (let index = 0; index < 5; index++) { const row = node('div', 'loading-row'); row.setAttribute('aria-hidden', 'true'); row.append(node('div', 'loading-line short'), node('div', 'loading-line long'), node('div', 'loading-line')); wrap.append(row); }
  host.replaceChildren(wrap);
}

function renderEmpty(host, title, message, retry) {
  const wrapper = node('div', 'empty-state'); wrapper.append(node('h3', '', title), node('p', '', message)); if (retry) wrapper.append(button('Try again', 'button', retry)); host.replaceChildren(wrapper);
}

function renderRows() {
  const host = $('rows'); host.replaceChildren(); host.setAttribute('aria-busy', String(state.listLoading));
  if (!state.rows.length) {
    const title = state.filters.q || activeFilterCount() ? 'No matching emails' : state.filters.view === 'attention' ? 'No emails need attention' : state.filters.view === 'queued' ? 'No emails are queued' : 'No emails in this view';
    renderEmpty(host, title, state.filters.q || activeFilterCount() ? 'Try a different search or broaden the filters.' : 'Emails recorded by Mailroom will appear here.');
  }
  const fragment = document.createDocumentFragment();
  for (const row of state.rows) {
    const link = node('a', 'email-row'); link.dataset.id = String(row.id); routeLink(link, { ...state.filters, id: String(row.id) });
    const top = node('span', 'row-top'); const who = node('span', 'recipient', recipient(row)); who.title = row.to_email || ''; const when = node('time', 'row-time', shortDate(rowDate(row))); when.title = fullDate(rowDate(row)); if (rowDate(row)) when.dateTime = rowDate(row); top.append(who, when);
    const bottom = node('span', 'row-bottom'); const lane = node('span', 'lane-tag', laneLabel(row)); lane.title = laneLabel(row); bottom.append(lane);
    if (row.has_attachments) { const mark = node('span', 'attachment-mark', 'Attachment'); bottom.append(mark); }
    bottom.append(badge(row)); link.append(top, node('span', 'subject', row.subject || '(No subject)'), node('span', 'snippet', row.snippet || 'No preview stored'), bottom); fragment.append(link);
  }
  host.append(fragment); renderSelection();
  $('loadMore').classList.toggle('hidden', !state.nextCursor); $('loadMore').disabled = state.listLoading;
  const total = state.counts?.[state.filters.view];
  $('listSummary').textContent = state.rows.length ? displayNumber(state.rows.length) + (total !== null && total !== undefined ? ' of ' + displayNumber(total) : '') + ' emails' : '0 emails';
}

async function loadList(append = false) {
  if (state.filters.view === 'lanes') return;
  if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) { gates.list.cancel(); state.rows = []; state.nextCursor = null; state.counts = null; renderRows(); renderControls(); showNotice('Choose a through date on or after the from date.'); return; }
  const ticket = gates.list.begin(); const query = listQuery(state.filters, append ? state.nextCursor : '');
  state.listLoading = true; $('rows').setAttribute('aria-busy', 'true'); $('loadMore').disabled = true; $('listSummary').textContent = append ? 'Loading more emails…' : 'Updating emails…';
  if (!state.rows.length) renderSkeleton($('rows'));
  try {
    const result = await request(query, ticket); if (!ticket.isCurrent()) return;
    state.rows = append ? mergeMessageRows(state.rows, safeArray(result.rows)) : safeArray(result.rows);
    state.nextCursor = result.nextCursor || null; state.counts = result.counts || null; state.listCoverage = result.coverage || null; state.loadedAt = new Date(); state.listLoading = false;
    clearNotice(); renderControls(); renderRows(); renderCoverage(); announceFreshness();
  } catch (error) {
    if (!ticket.isCurrent() || error.name === 'AbortError') return;
    state.listLoading = false; $('rows').setAttribute('aria-busy', 'false'); $('loadMore').disabled = false;
    $('freshness').textContent = state.loadedAt ? 'Refresh failed · showing earlier data' : 'Unable to connect';
    $('listSummary').textContent = state.rows.length ? 'Earlier results · refresh failed' : 'Could not load emails';
    if (!state.rows.length) renderEmpty($('rows'), 'Emails could not be loaded', error.message, () => loadList());
    showNotice(state.rows.length ? 'The refresh failed. These are the previously loaded emails; newer activity may be missing.' : error.message, { error: true, auth: error.status === 401 || error.status === 403, retry: () => loadList(append) });
  }
}

function optionList(id, rows, label, value, emptyLabel) {
  const select = $(id); const fragment = document.createDocumentFragment(); const empty = node('option', '', emptyLabel); empty.value = ''; fragment.append(empty);
  for (const row of rows) { const option = node('option', '', label(row)); option.value = String(value(row)); fragment.append(option); }
  const selected = state.filters[id];
  if (selected && !rows.some(row => String(value(row)) === selected)) { const option = node('option', '', selected + ' (historical)'); option.value = selected; fragment.append(option); }
  select.replaceChildren(fragment); select.value = selected;
}

async function loadLanes() {
  const ticket = gates.lanes.begin();
  try {
    const result = await request(new URLSearchParams({ mode: 'lanes' }), ticket); if (!ticket.isCurrent()) return;
    state.lanes = safeArray(result.lanes); state.senders = safeArray(result.senders); state.laneCoverage = result.coverage || null; state.lanesLoaded = true;
    optionList('lane', state.lanes, row => row.name || row.id, row => row.id, 'All lanes'); optionList('sender', state.senders, row => row.mailbox || row.id, row => row.id, 'All senders');
    renderLanes(); renderCoverage();
    if (state.filters.view === 'lanes') { state.loadedAt = new Date(); announceFreshness(); clearNotice(); }
  } catch (error) {
    if (!ticket.isCurrent() || error.name === 'AbortError') return;
    if (state.filters.view === 'lanes') { showNotice('Sending lanes could not be refreshed.' + (state.lanesLoaded ? ' Showing earlier records.' : ''), { error: true, auth: error.status === 401 || error.status === 403, retry: loadLanes }); if (!state.lanesLoaded) renderEmpty($('laneCards'), 'Lanes could not be loaded', error.message, loadLanes); }
  }
}

function renderLanes() {
  const host = $('laneCards');
  if (!state.lanesLoaded) { renderSkeleton(host); return; }
  if (!state.lanes.length) { renderEmpty(host, 'No SendGrid lanes recorded', 'Registered SendGrid lanes will appear here.'); return; }
  const cards = node('div', 'lane-cards');
  for (const lane of state.lanes) {
    const card = node('article', 'lane-card'); const header = node('div', 'lane-card-header'); const enabled = lane.enabled === true ? 'Enabled' : lane.enabled === false ? 'Paused' : 'State unknown'; header.append(node('h3', '', lane.name || lane.id), node('span', 'badge ' + (lane.enabled === true ? 'enabled' : 'paused'), enabled));
    const sender = node('p', 'lane-sender', lane.mailbox || lane.sender_id || 'Sender not recorded');
    if (lane.sender_status && !['active', 'enabled'].includes(lane.sender_status)) sender.append(node('span', '', ' · sender ' + String(lane.sender_status).replaceAll('_', ' ')));
    const stats = node('div', 'lane-stats');
    for (const [key, label] of [['sent_24h', 'Sent in 24 hours'], ['queued', 'Queued'], ['attention', 'Need attention']]) { const value = node('div', key === 'attention' && Number(lane[key]) > 0 ? 'problem' : ''); value.append(node('strong', '', displayNumber(lane[key])), node('span', '', label)); stats.append(value); }
    const footer = node('div', 'lane-card-footer'); const when = node('time', '', lane.last_sent ? 'Last sent ' + shortDate(lane.last_sent) : 'No send recorded'); when.title = fullDate(lane.last_sent); const link = routeLink(node('a', '', 'View emails →'), { ...EMPTY_FILTERS, view: 'all', lane: String(lane.id) }); footer.append(when, link);
    card.append(header, node('p', 'lane-purpose', lanePurpose(lane)), sender, stats, footer);
    if (lane.description) {
      const notes = node('details', 'lane-registry-notes');
      notes.append(node('summary', '', 'Registry notes'), node('p', 'registry-note-context', 'These notes may describe the original setup. The status above shows the lane’s current setting.'), node('p', '', lane.description));
      card.append(notes);
    }
    cards.append(card);
  }
  host.replaceChildren(cards);
}

function sanitizeEmailHTML(html) {
  // Template contents stay inert, including resource fetching, while untrusted
  // markup is stripped. Never attach this template or its content to the page.
  const template = document.createElement('template');
  template.innerHTML = String(html);
  template.content.querySelectorAll('script,iframe,frame,frameset,object,embed,base,meta,link,form,input,button,textarea,select,video,audio,source,track,svg,math,template').forEach(element => element.remove());
  // Drop resource-bearing CSS before previewing; the iframe CSP also blocks
  // every external request. Backslashes can disguise CSS url/import tokens.
  const resourceCSS = /[\\@]|(?:url|image|image-set|cross-fade)\s*\(/i;
  template.content.querySelectorAll('style').forEach(element => { if (resourceCSS.test(element.textContent)) element.remove(); });
  template.content.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['href', 'xlink:href', 'action', 'formaction', 'target', 'ping', 'srcdoc', 'srcset', 'autofocus', 'contenteditable', 'background', 'poster'].includes(name)) element.removeAttribute(attribute.name);
      if (name === 'src' && (element.tagName !== 'IMG' || !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value))) element.removeAttribute(attribute.name);
      if (name === 'style' && resourceCSS.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  });
  return wrapSafeEmailHTML(template.innerHTML);
}

function detailPair(list, label, value, className = '') {
  list.append(node('dt', '', label)); const detail = node('dd', className); if (value instanceof Node) detail.append(value); else detail.textContent = String(value || 'Not recorded'); list.append(detail);
}

function buildBody(row) {
  const wrapper = node('section', 'message-body');
  const header = node('div', 'body-header'); header.append(node('h3', '', 'Stored message'));
  const tabs = node('div', 'body-tabs'); tabs.setAttribute('aria-label', 'Message format');
  const host = node('div', 'body-content');
  const hasText = typeof row.body_text === 'string' && row.body_text.length > 0;
  const hasHTML = typeof row.body_html === 'string' && row.body_html.length > 0;
  let selected = hasText ? 'text' : hasHTML ? 'html' : 'text';
  function show(mode) {
    selected = mode; host.replaceChildren();
    tabs.querySelectorAll('button').forEach(element => element.setAttribute('aria-pressed', String(element.dataset.mode === mode)));
    if (mode === 'html' && hasHTML) { const frame = node('iframe', 'email-html'); frame.title = 'Stored email HTML — isolated preview'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.srcdoc = sanitizeEmailHTML(row.body_html); host.append(frame, node('p', 'body-note', 'Remote images, links, and active content are disabled in this preview.'));
    } else if (hasText) host.append(node('pre', 'email-text', row.body_text));
    else renderEmpty(host, 'Message content unavailable', 'This historical record does not include a stored email body.');
  }
  if (hasText && hasHTML) for (const [mode, label] of [['text', 'Text'], ['html', 'HTML']]) { const tab = button(label, '', () => show(mode)); tab.dataset.mode = mode; tab.setAttribute('aria-pressed', String(mode === selected)); tabs.append(tab); }
  header.append(tabs); wrapper.append(header, host); show(selected); return wrapper;
}

function buildAttachments(row) {
  const attachments = safeArray(row.attachments); const section = node('section', 'detail-section'); section.append(node('h3', 'section-title', 'Attachments'));
  if (!attachments.length) section.append(node('p', 'detail-muted', row.has_attachments ? 'This record indicates an attachment, but its file and metadata are not available here.' : 'Attachment files and metadata are not recorded for this email.'));
  else {
    const list = node('div', 'attachments');
    for (const attachment of attachments) { const item = node('div', 'attachment'); const label = node('span', '', attachment.filename || attachment.name || 'Attachment'); const size = Number(attachment.size_bytes ?? attachment.size); label.append(node('small', '', (Number.isFinite(size) && size > 0 ? displayNumber(Math.ceil(size / 1024)) + ' KB · ' : '') + 'Metadata only · file unavailable')); item.append(label); list.append(item); }
    section.append(list);
  }
  return section;
}

function buildTimeline(result) {
  const section = node('section', 'detail-section'); section.append(node('h3', 'section-title', 'Delivery events'));
  const events = safeArray(result.deliveryEvents).slice().sort((a, b) => new Date(a.occurred_at).valueOf() - new Date(b.occurred_at).valueOf());
  if (!events.length) { section.append(node('p', 'detail-muted', 'No delivery events are recorded for this email.')); return section; }
  const list = node('ol', 'timeline');
  for (const event of events) { const item = node('li'); const heading = node('div', 'event-heading'); const type = String(event.event_type || 'Event').replaceAll('_', ' '); heading.append(node('strong', '', type.charAt(0).toUpperCase() + type.slice(1)), node('time', '', fullDate(event.occurred_at))); item.append(heading); if (event.reason || event.status) item.append(node('p', 'event-reason', [event.status, event.reason].filter(Boolean).join(' · '))); list.append(item); }
  section.append(list); return section;
}

function renderMessage(result) {
  const row = result.row; const reader = $('reader'); reader.replaceChildren();
  const toolbar = node('div', 'read-toolbar'); toolbar.append(button('← Back', 'back-button', () => { if (!window.RaydarNav?.back(state.currentScreen)) navigate({ ...state.filters, id: '' }, { push: false }); }), badge(row), node('span', 'message-nav-label', 'SendGrid · ' + laneLabel(row)));
  const content = node('div', 'reader-content'); const title = node('h2', 'message-subject', row.subject || '(No subject)'); content.append(title);
  const metadata = node('dl', 'message-addresses');
  detailPair(metadata, 'To', row.to_name && row.to_email ? row.to_name + ' <' + row.to_email + '>' : recipient(row), 'to');
  detailPair(metadata, 'From', row.display_name && row.mailbox ? row.display_name + ' <' + row.mailbox + '>' : row.mailbox || row.sender_id);
  if (row.reply_to) detailPair(metadata, 'Reply to', row.reply_to);
  detailPair(metadata, row.sent_at ? 'Sent' : 'Created', fullDate(row.sent_at || row.created_at));
  detailPair(metadata, 'Lane', button(laneLabel(row), '', () => navigate({ ...EMPTY_FILTERS, view: 'all', lane: String(row.lane_id || '') })));
  content.append(metadata, node('p', 'delivery-explanation', statusExplanation(row)));
  if (row.last_error) { const error = node('div', 'notice error', row.last_error); error.setAttribute('role', 'note'); content.append(error); }
  if (row.run_after && !row.sent_at && statusKey(row) === 'queued') content.append(node('p', 'detail-muted', 'Eligible for a send attempt after ' + fullDate(row.run_after) + '. Sending guards may still hold this email.'));
  content.append(buildBody(row), buildAttachments(row), buildTimeline(result));
  const related = safeArray(result.related).filter(item => String(item.id) !== String(row.id));
  const relatedSection = node('section', 'detail-section'); relatedSection.append(node('h3', 'section-title', 'Related outgoing emails'));
  if (!related.length) relatedSection.append(node('p', 'detail-muted', 'No related outgoing emails were found in Mailroom. Replies are not stored in this view.'));
  else { relatedSection.append(node('p', 'detail-muted', 'Other emails to this recipient or in the recorded thread. Replies are not stored in this view.')); for (const other of related) { const link = routeLink(node('a', 'related-message'), { ...state.filters, id: String(other.id) }); link.append(node('strong', '', other.subject || '(No subject)'), node('small', '', laneLabel(other) + ' · ' + fullDate(rowDate(other)))); relatedSection.append(link); } }
  content.append(relatedSection);
  const technical = node('details', 'metadata'); technical.append(node('summary', '', 'Message records')); const records = node('dl');
  for (const [key, label] of [['id', 'Mailroom record'], ['state', 'Mailroom state'], ['sender_id', 'Sender ID'], ['provider_message_id', 'SendGrid message ID'], ['rfc822_message_id', 'Email Message-ID'], ['in_reply_to', 'In reply to'], ['references_header', 'References']]) if (row[key]) detailPair(records, label, Array.isArray(row[key]) ? row[key].join(' ') : row[key]);
  technical.append(records); content.append(technical);
  const notes = safeArray(result.coverage?.notes);
  if (notes.length) { const section = node('section', 'detail-section'); section.append(node('h3', 'section-title', 'Record coverage')); for (const note of notes) section.append(node('p', 'detail-muted', typeof note === 'string' ? note : note.message || note.note || 'Some historical fields are unavailable.')); content.append(section); }
  reader.append(toolbar, content);
}

async function loadMessage(id) {
  const ticket = gates.message.begin(); const reader = $('reader'); renderEmpty(reader, 'Loading email…', 'Fetching the stored message and delivery events.');
  try {
    const result = await request(new URLSearchParams({ mode: 'message', id }), ticket); if (!ticket.isCurrent() || state.filters.id !== id) return;
    if (!result.found || !result.row) { reader.replaceChildren(button('← Back', 'button', () => navigate({ ...state.filters, id: '' }))); const missing = node('div'); renderEmpty(missing, 'Email not found', 'This record is unavailable or is outside the SendGrid mail shown here.'); reader.append(missing); return; }
    state.message = result; renderMessage(result); reader.scrollTop = 0;
  } catch (error) {
    if (!ticket.isCurrent() || error.name === 'AbortError') return;
    reader.replaceChildren(button('← Back', 'button', () => navigate({ ...state.filters, id: '' }))); const failed = node('div'); renderEmpty(failed, 'Email could not be loaded', error.message, () => loadMessage(id)); reader.append(failed);
    if (error.status === 401 || error.status === 403) showNotice(error.message, { error: true, auth: true });
  }
}

function renderCoverage() {
  const coverage = state.filters.view === 'lanes' ? state.laneCoverage : state.listCoverage;
  if (!coverage) return;
  const summary = ['History and coverage']; if (coverage.total !== undefined && coverage.total !== null) summary.push(displayNumber(coverage.total) + ' retained emails'); if (coverage.earliest_at) summary.push('since ' + new Date(coverage.earliest_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
  $('coverageSummary').textContent = summary.join(' · '); const host = $('coverageDetails'); host.replaceChildren();
  host.append(node('p', '', 'This browser shows SendGrid messages recorded by Mailroom. Sent includes recorded sends and provider-accepted messages; delivery is shown separately. Counts in the sidebar follow the active email filters.'));
  const notes = [...safeArray(coverage.notes)];
  if (!notes.length) notes.push('Historical availability depends on what Mailroom retained. A missing body, attachment, sender snapshot, or delivery event is shown as unavailable.');
  const list = node('ul'); for (const note of notes) list.append(node('li', '', typeof note === 'string' ? note : note.message || note.note || 'Some historical fields are unavailable.')); host.append(list);
}

function refreshAll() { clearNotice(); loadLanes(); if (state.filters.view !== 'lanes') loadList(); if (state.filters.id && state.filters.view !== 'lanes') loadMessage(state.filters.id); }

document.querySelectorAll('[data-view]').forEach(element => element.addEventListener('click', () => navigate({ ...state.filters, view: element.dataset.view, id: '' })));
for (const key of ['lane', 'sender', 'delivery', 'from', 'to']) $(key).addEventListener('change', () => navigate({ ...state.filters, [key]: $(key).value, id: '' }));
$('filterToggle').addEventListener('click', () => { const open = $('filterToggle').getAttribute('aria-expanded') !== 'true'; $('filterToggle').setAttribute('aria-expanded', String(open)); $('filters').classList.toggle('hidden', !open); });
$('clearFilters').addEventListener('click', () => navigate({ ...state.filters, lane: '', sender: '', delivery: '', from: '', to: '', id: '' }));
$('refresh').addEventListener('click', refreshAll);
$('loadMore').addEventListener('click', () => { if (state.nextCursor && !state.listLoading) loadList(true); });
let searchTimer;
function applySearch() { clearTimeout(searchTimer); navigate({ ...state.filters, q: $('search').value.trim(), id: '' }); }
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applySearch, 320); });
$('searchForm').addEventListener('submit', event => { event.preventDefault(); applySearch(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && state.filters.view !== 'lanes') { event.preventDefault(); $('search').focus(); }
  if (event.key === 'Escape' && state.filters.id && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { if (!window.RaydarNav?.back(state.currentScreen)) navigate({ ...state.filters, id: '' }, { push: false }); }
});
$('filterHint').textContent = 'Dates use ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time zone') + '. Company and role search matches their names in stored message text.';
let restored = false;
window.RaydarNav?.restore(address => { restored = true; const target = addressState(address); state.filters = { ...EMPTY_FILTERS }; navigate(target); });
if (!restored) { renderControls(); if (state.filters.view !== 'lanes') loadList(); if (state.filters.id) loadMessage(state.filters.id); }
loadLanes();
