const $ = (s, el = document) => el.querySelector(s);
const LABELS = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', review: 'Review', done: 'Done' };
const touch = matchMedia('(pointer: coarse)').matches;

let state = { statuses: [], projects: [], cards: [], chats: {} };
let openCardId = null;
let tab = store('board.tab') || 'main'; // "main" or a project id; also filters the board
let archiveOpen = store('board.archiveOpen') === '1';
const isArchived = (id) => !!state.projects.find((p) => p.id === id)?.archived;
const unread = new Set();

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Minimal markdown: fenced code, inline code, bold.
// Small markdown renderer: code blocks, headings, lists, rules, paragraphs,
// inline code, bold, italic. Enough for agent replies.
function mdInline(t) {
  return esc(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
}

function mdBlocks(text) {
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const lines = text.split('\n');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    // Table: a | row followed by a |---| separator row.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flushPara(); flushList();
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/))) { flushPara(); flushList(); out.push(`<p class="h">${mdInline(m[1])}</p>`); continue; }
    if ((m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/))) {
      const tag = m[1] ? 'ol' : 'ul';
      flushPara();
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

function md(s) {
  return s.split(/```[^\n]*\n?([\s\S]*?)```/g)
    .map((part, i) => (i % 2 ? `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>` : mdBlocks(part)))
    .join('');
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) location.reload();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

const projectName = (id) => state.projects.find((p) => p.id === id)?.name || id;
const tabName = (key) => (key === 'main' ? 'Main' : projectName(key));
const tabForLog = (logId) => Object.keys(state.chats).find((k) => state.chats[k].logId === logId);

// ---------- view toggle (phones) ----------

function setView(view) {
  document.body.dataset.view = view;
  store('board.view', view);
}
document.querySelectorAll('.viewtoggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
setView(store('board.view') || 'chat');

// ---------- board ----------

function badge(card) {
  if (card.run) return `<span class="badge ${card.run.state}">${card.run.state === 'running' ? 'Running' : 'Queued'}</span>`;
  const last = card.lastRun?.state;
  if (card.status === 'review' && last && last !== 'done') return `<span class="badge ${last}">${last[0].toUpperCase() + last.slice(1)}</span>`;
  return '';
}

function renderBoard() {
  const all = tab === 'main';
  const cards = state.cards.filter((c) => (all ? !isArchived(c.project) : c.project === tab));
  $('#board').innerHTML = state.statuses.map((s) => {
    const col = cards.filter((c) => c.status === s).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return `<section class="col" data-status="${s}">
      <div class="col-head"><span>${LABELS[s]}</span><span class="count">${col.length}</span></div>
      <div class="cards">${col.map((c) => `
        <article class="card" data-id="${c.id}" draggable="${!touch}">
          <div class="t">${esc(c.title)}</div>
          <div class="meta">${all ? `<span class="chip">${esc(projectName(c.project))}</span>` : ''}${badge(c)}</div>
        </article>`).join('')}</div>
    </section>`;
  }).join('');
}

$('#board').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openCard(card.dataset.id);
});

// Desktop drag and drop; on phones use the status pills in the card.
$('#board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (card) e.dataTransfer.setData('text/plain', card.dataset.id);
});
$('#board').addEventListener('dragover', (e) => {
  const col = e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.col.over').forEach((c) => c !== col && c.classList.remove('over'));
  col.classList.add('over');
});
$('#board').addEventListener('dragleave', (e) => {
  if (!e.currentTarget.contains(e.relatedTarget)) document.querySelectorAll('.col.over').forEach((c) => c.classList.remove('over'));
});
$('#board').addEventListener('drop', guard(async (e) => {
  const col = e.target.closest('.col');
  document.querySelectorAll('.col.over').forEach((c) => c.classList.remove('over'));
  const id = e.dataTransfer.getData('text/plain');
  if (col && id) await moveCard(id, col.dataset.status);
}));

async function moveCard(id, status) {
  const card = state.cards.find((c) => c.id === id);
  if (!card || card.status === status) return;
  await api('PATCH', `/api/cards/${id}`, { status });
}

// ---------- transcript ----------

function eventHtml(ev) {
  const body = ev.kind === 'text' ? md(ev.text) : esc(ev.text);
  return `<div class="ev ${ev.kind}">${body}</div>`;
}

function renderLog(el, events, emptyText) {
  el.innerHTML = events.length ? events.map(eventHtml).join('') : `<div class="empty">${esc(emptyText)}</div>`;
  el.scrollTop = el.scrollHeight;
}

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

function appendEvent(el, ev) {
  const stick = nearBottom(el);
  el.querySelector('.empty')?.remove();
  el.querySelector('.working')?.remove();
  el.insertAdjacentHTML('beforeend', eventHtml(ev));
  if (stick) el.scrollTop = el.scrollHeight;
}

function setWorking(el, text) {
  const current = el.querySelector('.working');
  if (current && current.textContent === text && el.lastElementChild === current) return;
  current?.remove();
  if (!text) return;
  const stick = nearBottom(el);
  el.insertAdjacentHTML('beforeend', `<div class="working">${esc(text)}</div>`);
  if (stick) el.scrollTop = el.scrollHeight;
}

// ---------- chat pane ----------

function renderTabs() {
  if (tabDrag?.active) return; // don't rebuild the strip mid-drag
  const keys = ['main', ...state.projects.map((p) => p.id)];
  if (!keys.includes(tab)) tab = 'main';
  const anyBusy = keys.some((k) => state.chats[k]?.busy);
  $('#chatExpand .dot').className = `dot ${anyBusy ? 'busy' : unread.size ? 'unread' : ''}`;
  const tabBtn = (k, extra = '') => {
    const dot = state.chats[k]?.busy ? 'busy' : unread.has(k) ? 'unread' : '';
    const movable = k !== 'main' && !extra ? ' movable' : '';
    return `<button class="tab${k === tab ? ' on' : ''}${extra}${movable}" data-tab="${esc(k)}">${esc(tabName(k))}<span class="dot ${dot}"></span></button>`;
  };
  const active = ['main', ...state.projects.filter((p) => !p.archived).map((p) => p.id)];
  const archived = state.projects.filter((p) => p.archived).map((p) => p.id);
  // The archive folder stays open while one of its projects is the open tab.
  const open = archiveOpen || archived.includes(tab);
  // Divider after Main: Main is fixed, the project tabs after it can be dragged.
  let html = active.map((k) => tabBtn(k) + (k === 'main' ? '<span class="sep"></span>' : '')).join('');
  if (archived.length) {
    html += '<span class="sep"></span>'
      + `<button class="tab folder" data-folder title="${open ? 'Close' : 'Open'} the archive">${open ? '▾' : '▸'} Archive <span class="n">${archived.length}</span></button>`;
    if (open) html += archived.map((k) => tabBtn(k, ' archived')).join('');
  }
  $('#tabs').innerHTML = html;
}

function renderChatControls() {
  const busy = !!state.chats[tab]?.busy;
  $('#chatStop').hidden = !busy;
  const arch = $('#chatArchive');
  arch.hidden = tab === 'main';
  arch.textContent = isArchived(tab) ? 'Unarchive' : 'Archive';
  arch.title = isArchived(tab) ? 'Move back to the active projects' : 'Move its folder into the archive folder and hide its cards from Main';
  arch.disabled = busy;
  $('#chatReset').disabled = busy;
  $('#chatForm button').disabled = busy;
  $('#chatHint').textContent = tab === 'main'
    ? 'Main brain. Sees every project and the board.'
    : `Claude Code in the ${projectName(tab)} folder.`;
  $('#chatForm textarea').placeholder = tab === 'main' ? 'Talk to the main brain…' : `Message ${projectName(tab)}…`;
  setWorking($('#chatLog'), busy ? 'Working' : '');
}

let chatLoad = 0;
async function selectTab(key) {
  tab = key;
  store('board.tab', key);
  unread.delete(key);
  renderTabs();
  renderBoard();
  renderChatControls();
  $('#tabs .tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const n = ++chatLoad;
  const log = await api('GET', `/api/chats/${key}/log?limit=300`).catch(() => []);
  if (n !== chatLoad) return;
  renderLog($('#chatLog'), log, key === 'main'
    ? 'Tell me what you want to get done. I turn it into cards and start them when you say go.'
    : `Chat with Claude Code inside ${projectName(key)}. Same as opening a terminal there.`);
  renderChatControls();
}

// ---------- drag to reorder project tabs ----------
// Mouse: press and move. Touch: hold ~0.35s, then move (a quick swipe still
// scrolls the strip). Main and archived tabs don't move. The order is saved
// in projects.json on the server.

let tabDrag = null;
let suppressTabClick = false;

$('#tabs').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tab.movable');
  if (!el || e.button > 0) return;
  tabDrag = { el, id: e.pointerId, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== 'mouse' };
  if (tabDrag.touch) tabDrag.timer = setTimeout(() => startTabDrag(), 350);
});

function startTabDrag() {
  if (!tabDrag) return;
  tabDrag.active = true;
  tabDrag.el.classList.add('dragging');
  document.body.classList.add('tab-dragging');
  try { tabDrag.el.setPointerCapture(tabDrag.id); } catch {}
  navigator.vibrate?.(10);
}

window.addEventListener('pointermove', (e) => {
  if (!tabDrag || e.pointerId !== tabDrag.id) return;
  const moved = Math.hypot(e.clientX - tabDrag.x, e.clientY - tabDrag.y);
  if (!tabDrag.active) {
    if (tabDrag.touch) { if (moved > 8) cancelTabDrag(); return; } // it's a scroll
    if (moved < 6) return;
    startTabDrag();
  }
  const strip = $('#tabs');
  const others = [...strip.querySelectorAll('.tab.movable')].filter((t) => t !== tabDrag.el);
  const before = others.find((t) => { const r = t.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
  const lastMovable = others[others.length - 1];
  if (before) { if (tabDrag.el.nextElementSibling !== before) strip.insertBefore(tabDrag.el, before); }
  else if (lastMovable && lastMovable.nextElementSibling !== tabDrag.el) lastMovable.after(tabDrag.el);
  const r = strip.getBoundingClientRect(); // auto-scroll near the edges
  if (e.clientX < r.left + 30) strip.scrollLeft -= 12;
  else if (e.clientX > r.right - 30) strip.scrollLeft += 12;
});

// While dragging on touch, stop the strip (and page) from scrolling.
$('#tabs').addEventListener('touchmove', (e) => { if (tabDrag?.active) e.preventDefault(); }, { passive: false });
$('#tabs').addEventListener('contextmenu', (e) => { if (e.target.closest('.tab.movable')) e.preventDefault(); });

window.addEventListener('pointerup', (e) => { if (tabDrag && e.pointerId === tabDrag.id) endTabDrag(); });
window.addEventListener('pointercancel', (e) => { if (tabDrag && e.pointerId === tabDrag.id) cancelTabDrag(); });

function cancelTabDrag() {
  if (!tabDrag) return;
  clearTimeout(tabDrag.timer);
  const wasActive = tabDrag.active;
  tabDrag.el.classList.remove('dragging');
  document.body.classList.remove('tab-dragging');
  tabDrag = null;
  if (wasActive) renderTabs();
}

const endTabDrag = guard(async () => {
  const wasActive = tabDrag.active;
  clearTimeout(tabDrag.timer);
  tabDrag.el.classList.remove('dragging');
  document.body.classList.remove('tab-dragging');
  tabDrag = null;
  if (!wasActive) return;
  suppressTabClick = true;
  setTimeout(() => { suppressTabClick = false; }, 0);
  const order = [...$('#tabs').querySelectorAll('.tab.movable')].map((t) => t.dataset.tab);
  const { projects } = await api('POST', '/api/projects/order', { order });
  state.projects = projects;
  renderTabs();
});

$('#tabs').addEventListener('click', (e) => {
  if (suppressTabClick) { suppressTabClick = false; return; }
  if (e.target.closest('[data-folder]')) {
    const archived = state.projects.filter((p) => p.archived).map((p) => p.id);
    archiveOpen = !(archiveOpen || archived.includes(tab));
    store('board.archiveOpen', archiveOpen ? '1' : '0');
    if (!archiveOpen && archived.includes(tab)) selectTab('main');
    else renderTabs();
    return;
  }
  const t = e.target.closest('.tab');
  if (t && t.dataset.tab !== tab) selectTab(t.dataset.tab);
});
$('#chatStop').addEventListener('click', guard(() => api('POST', `/api/chats/${tab}/stop`)));
$('#chatArchive').addEventListener('click', guard(async () => {
  const id = tab;
  if (isArchived(id)) {
    const r = await api('POST', `/api/projects/${id}/unarchive`);
    toast(`${projectName(id)} is back in ${r.path}`);
  } else {
    if (!confirm(`Archive ${projectName(id)}?\n\nIts folder moves into the "archive" folder next to it (e.g. Projects/archive/${projectName(id)}), and its cards leave Main. Close it in any editor or terminal first. You can unarchive it anytime.`)) return;
    const r = await api('POST', `/api/projects/${id}/archive`);
    toast(`${projectName(id)} moved to ${r.path}`);
    selectTab('main');
  }
}));
$('#chatReset').addEventListener('click', guard(() => api('POST', `/api/chats/${tab}/reset`)));

// ---------- chat pane: collapse + drag to resize (desktop) ----------

function setChatCollapsed(collapsed) {
  document.body.dataset.chat = collapsed ? 'collapsed' : 'open';
  store('board.chat', collapsed ? 'collapsed' : 'open');
}
setChatCollapsed(store('board.chat') === 'collapsed');
$('#chatCollapse').addEventListener('click', () => setChatCollapsed(true));
$('#chatExpand').addEventListener('click', () => {
  setChatCollapsed(false);
  if (!touch) $('#chatForm textarea').focus();
});

const MIN_CHAT = 300;
const MIN_BOARD = 260;
function setChatWidth(px, save = true) {
  const layout = $('.layout').getBoundingClientRect();
  const w = Math.round(Math.max(MIN_CHAT, Math.min(px, layout.width - MIN_BOARD - 6)));
  document.documentElement.style.setProperty('--chat-w', `${w}px`);
  if (save) store('board.chatW', String(w));
}
function resetChatWidth() {
  document.documentElement.style.removeProperty('--chat-w');
  try { localStorage.removeItem('board.chatW'); } catch {}
}
const savedW = Number(store('board.chatW'));
if (savedW && innerWidth >= 900) setChatWidth(savedW, false);

const splitter = $('#splitter');
splitter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const right = $('.layout').getBoundingClientRect().right;
  const move = (ev) => setChatWidth(right - ev.clientX, false);
  const up = (ev) => {
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    splitter.removeEventListener('pointercancel', up);
    document.body.classList.remove('resizing');
    setChatWidth(right - ev.clientX);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});
splitter.addEventListener('dblclick', resetChatWidth);
addEventListener('resize', () => {
  const w = Number(store('board.chatW'));
  if (w && innerWidth >= 900) setChatWidth(w, false);
});
splitter.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const w = $('.chat').getBoundingClientRect().width;
  setChatWidth(w + (e.key === 'ArrowLeft' ? 24 : -24));
});
composer($('#chatForm'), (text) => api('POST', `/api/chats/${tab}`, { text }));

// ---------- card sheet ----------

const cardDlg = $('#cardDlg');

async function openCard(id) {
  openCardId = id;
  renderCardSheet(true);
  cardDlg.showModal();
  const log = await api('GET', `/api/cards/${id}/log`).catch(() => []);
  if (openCardId === id) {
    renderLog($('#cardLog'), log, 'No activity yet. Add details, then Start.');
    renderCardSheet(false);
  }
}

function renderCardSheet(full) {
  const card = state.cards.find((c) => c.id === openCardId);
  if (!card) { if (cardDlg.open) cardDlg.close(); return; }
  const sel = $('#cardProject');
  sel.innerHTML = state.projects
    .filter((p) => !p.archived || p.id === card.project)
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.archived ? ' (archived)' : ''}</option>`).join('');
  sel.value = card.project;
  sel.disabled = !!card.run;
  if (full || document.activeElement !== $('#cardTitle')) $('#cardTitle').value = card.title;
  if (full || document.activeElement !== $('#cardDetails')) $('#cardDetails').value = card.details || '';
  if (full) $('#cardSaved').textContent = '';
  $('#cardStatus').innerHTML = state.statuses.map((s) =>
    `<button type="button" class="pill${card.status === s ? ' on' : ''}" data-status="${s}">${LABELS[s]}</button>`).join('');
  const running = !!card.run;
  $('#cardStop').hidden = !running;
  $('#cardStart').hidden = running;
  $('#cardStart').textContent = card.sessionId ? 'Resume ▶' : 'Start ▶';
  $('#cardDelete').disabled = running;
  $('#cardReview').hidden = running || card.status !== 'review';
  const reply = $('#cardReply');
  reply.hidden = !card.sessionId;
  reply.querySelector('button').disabled = running;
  const working = card.run?.state === 'running' ? 'Working'
    : card.run?.state === 'queued' ? `Queued, waiting for ${projectName(card.project)}` : '';
  setWorking($('#cardLog'), working);
}

$('#cardStatus').addEventListener('click', guard(async (e) => {
  const pill = e.target.closest('.pill');
  if (pill) await moveCard(openCardId, pill.dataset.status);
}));
$('#cardStart').addEventListener('click', guard(async () => {
  await saveDetails();
  await api('PATCH', `/api/cards/${openCardId}`, { status: 'in_progress' });
}));
$('#cardStop').addEventListener('click', guard(() => api('POST', `/api/cards/${openCardId}/stop`)));

// Review buttons: fixed actions, the agent isn't asked anything.
$('#cardApprove').addEventListener('click', guard(() => api('POST', `/api/cards/${openCardId}/approve`)));
for (const [btn, action] of [['#cardReject', 'reject'], ['#cardRedo', 'redo']]) {
  $(btn).addEventListener('click', guard(async () => {
    const card = state.cards.find((c) => c.id === openCardId);
    const name = projectName(card.project);
    const then = action === 'reject' ? 'send the card back to Ready' : 'run the card again from scratch';
    const msg = card.canRevert
      ? `${action === 'reject' ? 'Reject' : 'Redo'}: revert everything changed in ${name} since this card started, then ${then}?\n\n`
        + 'Your uncommitted work from before the card is kept. Changes made meanwhile from the project chat are reverted too.'
      : `Nothing to revert for this card (no snapshot). ${then[0].toUpperCase() + then.slice(1)}?`;
    if (!confirm(msg)) return;
    const r = await api('POST', `/api/cards/${openCardId}/${action}`);
    toast(r.note);
  }));
}
$('#cardDelete').addEventListener('click', guard(async () => {
  if (!confirm('Delete this card and its transcript?')) return;
  await api('DELETE', `/api/cards/${openCardId}`);
  cardDlg.close();
}));
$('#cardProject').addEventListener('change', guard((e) => api('PATCH', `/api/cards/${openCardId}`, { project: e.target.value })));
$('#cardTitle').addEventListener('change', guard((e) => api('PATCH', `/api/cards/${openCardId}`, { title: e.target.value })));

let detailsTimer;
async function saveDetails() {
  clearTimeout(detailsTimer);
  const card = state.cards.find((c) => c.id === openCardId);
  const value = $('#cardDetails').value;
  if (!card || value === (card.details || '')) return;
  await api('PATCH', `/api/cards/${openCardId}`, { details: value });
  $('#cardSaved').textContent = 'Saved';
}
$('#cardDetails').addEventListener('input', () => {
  $('#cardSaved').textContent = '';
  clearTimeout(detailsTimer);
  detailsTimer = setTimeout(guard(saveDetails), 800);
});
$('#cardDetails').addEventListener('blur', guard(saveDetails));
cardDlg.addEventListener('close', () => { saveDetails().catch(() => {}); openCardId = null; });

composer($('#cardReply'), (text) => api('POST', `/api/cards/${openCardId}/reply`, { text }));

// ---------- new card ----------

const newDlg = $('#newDlg');
$('#refreshBtn').addEventListener('click', guard(async () => {
  const before = state.projects.length;
  const { projects } = await api('POST', '/api/projects/refresh');
  const added = projects.length - before;
  toast(added > 0 ? `${added} new project${added > 1 ? 's' : ''}` : 'Projects up to date');
}));

$('#newBtn').addEventListener('click', () => {
  const f = $('#newForm');
  f.reset();
  const choices = state.projects.filter((p) => !p.archived || p.id === tab);
  f.project.innerHTML = choices.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const last = store('board.lastProject');
  f.project.value = tab !== 'main' ? tab : choices.some((p) => p.id === last) ? last : choices[0]?.id || '';
  newDlg.showModal();
  if (!touch) f.title.focus();
});
$('#newForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const card = await api('POST', '/api/cards', {
    project: f.project.value, title: f.title.value, details: f.details.value, status: f.status.value,
  });
  store('board.lastProject', f.project.value);
  newDlg.close();
  if (f.status.value === 'in_progress') openCard(card.id);
}));

// ---------- shared ----------

function composer(form, sendFn) {
  const ta = form.querySelector('textarea');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || form.querySelector('button').disabled) return;
    await sendFn(text);
    ta.value = '';
    grow();
  }));
}

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

let first = true;
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#conn').classList.add('live');
  es.onerror = () => $('#conn').classList.remove('live');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      state = msg.state;
      if (first) { first = false; selectTab(tab); return; }
      renderTabs();
      renderBoard();
      renderChatControls();
      if (openCardId) renderCardSheet(false);
    } else if (msg.type === 'clear') {
      const key = tabForLog(msg.id);
      if (key) unread.delete(key);
      if (key === tab) {
        renderLog($('#chatLog'), [], 'Chat cleared. Start a new conversation.');
        renderChatControls();
      }
      renderTabs();
    } else if (msg.type === 'log') {
      const key = tabForLog(msg.id);
      if (key === tab) appendEvent($('#chatLog'), msg.event);
      else if (key && msg.event.kind === 'text') { unread.add(key); renderTabs(); }
      if (msg.id === openCardId) { appendEvent($('#cardLog'), msg.event); renderCardSheet(false); }
      if (key === tab) renderChatControls();
    }
  };
}

connect();
