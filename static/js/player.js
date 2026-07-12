/* ==========================================================================
   Per-guild player page.

   Wired to the real dashboard API/WS contract in app.py:
     GET  /api/guilds/{id}/player
     WS   /ws/{id}                         (live push on every change)
     POST /api/guilds/{id}/pause|resume|skip|stop|volume|loop|shuffle
     POST /api/guilds/{id}/previous|replay|play
     POST /api/guilds/{id}/queue/{index}/remove

   Two things in the reference design have no backend support yet and
   are handled honestly rather than faked:
     - Audio Filter pills: UI-only selection for now (no lavalink filter
       endpoint exists in app.py). Wire `applyFilterOnServer()` up once
       one exists.
     - Server Top Hits: tries `GET /api/guilds/{id}/top-tracks` first;
       if that 404s (it will, until it's built), falls back to a
       per-browser local tally so the panel isn't empty on day one.
   ========================================================================== */

const page = document.getElementById('player-page');
const GUILD_ID = page.dataset.guildId;
const GUILD_NAME = page.dataset.guildName;
const GUILD_ICON = page.dataset.guildIcon || null;

const LS_RECENT = 'Maya:recentlyPlayed';
const LS_MOST_PLAYED = 'Maya:mostPlayed';
const LS_FAVOURITES = 'Maya:favourites';
const LS_TOP_HITS = `Maya:topHits:${GUILD_ID}`;

function readLS(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
}

let state = { connected: false };
let lastTrackId = null;
let localPositionMs = 0;
let tickHandle = null;

/* ── Recently played (for the home dashboard) ─────────────────────── */
(function recordRecentlyPlayed() {
  const recents = readLS(LS_RECENT, []).filter((r) => r.id !== GUILD_ID);
  recents.unshift({ id: GUILD_ID, name: GUILD_NAME, icon: GUILD_ICON, ts: Date.now() });
  writeLS(LS_RECENT, recents.slice(0, 10));
})();

/* ── WebSocket live sync ───────────────────────────────────────────── */

let ws = null;
let reconnectDelay = 1000;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${GUILD_ID}`);

  ws.onopen = () => { reconnectDelay = 1000; };
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'player_update') applyState(msg.data);
  };
  ws.onclose = (evt) => {
    if (evt.code === 4001 || evt.code === 4003) {
      toast('Session expired — refresh to log in again.', 'error');
      return;
    }
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
  };
  ws.onerror = () => ws.close();
}

/* ── Rendering ──────────────────────────────────────────────────────── */

function applyState(data) {
  state = data;
  localPositionMs = data.position || 0;
  renderStatusBadge();
  renderNowPlaying();
  renderTransport();
  renderVolume();
  renderQueue();
  trackForTopHitsAndMostPlayed();
  restartTicker();
}

function renderStatusBadge() {
  const badge = document.getElementById('status-badge');
  if (!state.connected) { badge.textContent = 'Offline'; badge.className = 'badge idle'; return; }
  if (!state.current) { badge.textContent = 'Idle'; badge.className = 'badge idle'; return; }
  if (state.paused) { badge.textContent = 'Paused'; badge.className = 'badge paused'; return; }
  badge.textContent = 'Live'; badge.className = 'badge live';
}

function renderNowPlaying() {
  const art = document.getElementById('np-art');
  const title = document.getElementById('np-title');
  const author = document.getElementById('np-author');
  const cur = state.current;

  if (!cur) {
    art.innerHTML = notePlaceholderSvg();
    title.textContent = 'Nothing Playing';
    author.textContent = '\u2014';
    document.getElementById('progress-current').textContent = '0:00';
    document.getElementById('progress-total').textContent = '0:00';
    document.getElementById('progress-fill').style.width = '0%';
    return;
  }

  art.innerHTML = cur.thumbnail
    ? `<img src="${cur.thumbnail}" alt="">`
    : notePlaceholderSvg();
  title.textContent = cur.title;
  author.textContent = cur.author || '\u2014';
}

function notePlaceholderSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
}

function renderTransport() {
  const playBtn = document.getElementById('play-pause-btn');
  const hasTrack = !!state.current;
  playBtn.innerHTML = state.paused || !hasTrack ? playIconSvg() : pauseIconSvg();
  playBtn.disabled = !state.connected;

  document.getElementById('prev-btn').disabled = !state.connected;
  document.getElementById('next-btn').disabled = !state.connected;
  document.getElementById('replay-btn').disabled = !hasTrack;
  document.getElementById('shuffle-btn').disabled = !state.connected;

  document.getElementById('loop-btn').classList.toggle('active', !!state.loop);
  document.getElementById('favourite-btn').classList.toggle('active', isCurrentFavourited());
}

function renderVolume() {
  const slider = document.getElementById('volume-slider');
  const value = document.getElementById('volume-value');
  if (document.activeElement !== slider) slider.value = state.volume ?? 100;
  value.textContent = `${state.volume ?? 100}%`;
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');
  const queue = state.queue || [];
  countEl.textContent = queue.length ? `${state.queue_length}` : '';

  if (!queue.length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <div class="title">Queue is empty</div>
      <div class="hint">Search for a track above to add one.</div>
    </div>`;
    return;
  }

  list.innerHTML = queue.map((t) => `
    <div class="queue-row" data-index="${t.index}">
      ${t.thumbnail ? `<img class="q-art" src="${t.thumbnail}" alt="" loading="lazy">` : '<div class="q-art"></div>'}
      <div class="q-info">
        <div class="q-title">${escapeHtml(t.title)}</div>
        <div class="q-sub">${escapeHtml(t.author || '')} \u00b7 ${formatDuration(t.duration)}</div>
      </div>
      <button class="q-remove" data-index="${t.index}" title="Remove from queue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.q-remove').forEach((btn) => {
    btn.addEventListener('click', () => removeFromQueue(Number(btn.dataset.index)));
  });
}

/* local position ticking between WS pushes */
function restartTicker() {
  if (tickHandle) cancelAnimationFrame(tickHandle);
  let last = performance.now();
  const step = (now) => {
    const dt = now - last;
    last = now;
    if (state.connected && state.current && !state.paused) {
      localPositionMs = Math.min(localPositionMs + dt, state.current.duration || Infinity);
    }
    const dur = state.current ? state.current.duration : 0;
    document.getElementById('progress-current').textContent = formatDuration(localPositionMs);
    document.getElementById('progress-total').textContent = formatDuration(dur);
    document.getElementById('progress-fill').style.width = dur ? `${Math.min(100, (localPositionMs / dur) * 100)}%` : '0%';
    tickHandle = requestAnimationFrame(step);
  };
  tickHandle = requestAnimationFrame(step);
}

/* ── Local tallies: top hits (this server) + most played (all servers) ── */

function trackForTopHitsAndMostPlayed() {
  const cur = state.current;
  if (!cur || cur.identifier === lastTrackId) return;
  lastTrackId = cur.identifier;

  const bump = (key) => {
    const map = readLS(key, {});
    const entry = map[cur.identifier] || { title: cur.title, author: cur.author, thumbnail: cur.thumbnail, count: 0 };
    entry.count += 1;
    entry.title = cur.title;
    entry.author = cur.author;
    entry.thumbnail = cur.thumbnail;
    map[cur.identifier] = entry;
    writeLS(key, map);
  };
  bump(LS_TOP_HITS);
  bump(LS_MOST_PLAYED);
  loadTopHits();
}

async function loadTopHits() {
  const el = document.getElementById('top-hits-list');
  try {
    const data = await api(`/api/guilds/${GUILD_ID}/top-tracks`);
    renderTopHits(el, data.tracks || []);
  } catch {
    const map = readLS(LS_TOP_HITS, {});
    const tracks = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 6);
    renderTopHits(el, tracks);
  }
}

function renderTopHits(el, tracks) {
  if (!tracks.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="title">No hits yet</div>
      <div class="hint">Keep playing tracks in this server to build a leaderboard.</div>
    </div>`;
    return;
  }
  el.innerHTML = tracks.map((t, i) => `
    <div class="hits-row">
      <div class="hits-rank">${i + 1}</div>
      ${t.thumbnail ? `<img class="h-art" src="${t.thumbnail}" alt="" loading="lazy">` : '<div class="h-art"></div>'}
      <div class="h-info">
        <div class="h-title">${escapeHtml(t.title)}</div>
        <div class="h-sub">${escapeHtml(t.author || '')}</div>
      </div>
      <div class="h-count">${t.count}\u00d7</div>
    </div>
  `).join('');
}

/* ── Favourites (local) ─────────────────────────────────────────────── */

function isCurrentFavourited() {
  if (!state.current) return false;
  const favs = readLS(LS_FAVOURITES, []);
  return favs.some((f) => f.uri === state.current.uri);
}
function toggleFavourite() {
  if (!state.current) return;
  const favs = readLS(LS_FAVOURITES, []);
  const idx = favs.findIndex((f) => f.uri === state.current.uri);
  if (idx >= 0) {
    favs.splice(idx, 1);
    toast('Removed from favourites');
  } else {
    favs.unshift({ uri: state.current.uri, title: state.current.title, author: state.current.author, thumbnail: state.current.thumbnail });
    toast('Added to favourites', 'success');
  }
  writeLS(LS_FAVOURITES, favs);
  renderTransport();
}

/* ── Icons ──────────────────────────────────────────────────────────── */

function playIconSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }
function pauseIconSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'; }

/* ── Actions (call the real API) ──────────────────────────────────── */

async function withErrorToast(fn) {
  try { await fn(); } catch (err) { toast(err.message, 'error'); }
}

function removeFromQueue(index) {
  withErrorToast(() => api(`/api/guilds/${GUILD_ID}/queue/${index}/remove`, { method: 'POST' }));
}

async function clearQueue() {
  // There's no queue-only clear endpoint (only /stop, which also stops
  // playback), so we remove index 0 repeatedly to clear the queue
  // without interrupting the current track.
  await withErrorToast(async () => {
    let remaining = state.queue_length || 0;
    while (remaining > 0) {
      await api(`/api/guilds/${GUILD_ID}/queue/0/remove`, { method: 'POST' });
      remaining -= 1;
    }
    toast('Queue cleared', 'success');
  });
}

let volumeDebounce = null;
function onVolumeInput(vol) {
  document.getElementById('volume-value').textContent = `${vol}%`;
  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(() => {
    withErrorToast(() => api(`/api/guilds/${GUILD_ID}/volume`, { method: 'POST', body: { volume: Number(vol) } }));
  }, 250);
}

/* ── Audio filters (UI-only until a lavalink filter endpoint exists) ── */

function initFilters() {
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      if (!sessionStorage.getItem('Maya:filterNotice')) {
        toast('Audio filters are visual only for now \u2014 no backend effect is wired up yet.');
        sessionStorage.setItem('Maya:filterNotice', '1');
      }
    });
  });
}

/* ── Search / play ─────────────────────────────────────────────────── */

async function submitSearch() {
  const input = document.getElementById('search-input');
  const query = input.value.trim();
  if (!query) return;
  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  await withErrorToast(async () => {
    const data = await api(`/api/guilds/${GUILD_ID}/play`, { method: 'POST', body: { query } });
    toast(data.message || 'Added to queue', 'success');
    input.value = '';
  });
  btn.disabled = false;
}

/* ── Wire everything up ────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  loadTopHits();
  initFilters();

  document.getElementById('play-pause-btn').addEventListener('click', () => {
    withErrorToast(() => api(`/api/guilds/${GUILD_ID}/${state.paused ? 'resume' : 'pause'}`, { method: 'POST' }));
  });
  document.getElementById('prev-btn').addEventListener('click', () => withErrorToast(() => api(`/api/guilds/${GUILD_ID}/previous`, { method: 'POST' })));
  document.getElementById('next-btn').addEventListener('click', () => withErrorToast(() => api(`/api/guilds/${GUILD_ID}/skip`, { method: 'POST' })));
  document.getElementById('replay-btn').addEventListener('click', () => withErrorToast(() => api(`/api/guilds/${GUILD_ID}/replay`, { method: 'POST' })));
  document.getElementById('shuffle-btn').addEventListener('click', () => withErrorToast(async () => { await api(`/api/guilds/${GUILD_ID}/shuffle`, { method: 'POST' }); toast('Queue shuffled', 'success'); }));
  document.getElementById('loop-btn').addEventListener('click', () => withErrorToast(() => api(`/api/guilds/${GUILD_ID}/loop`, { method: 'POST', body: { loop: !state.loop } })));
  document.getElementById('favourite-btn').addEventListener('click', toggleFavourite);
  document.getElementById('queue-jump-btn').addEventListener('click', () => document.getElementById('up-next-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  document.getElementById('mic-btn').addEventListener('click', () => toast('Voice announcements aren\u2019t available yet.'));
  document.getElementById('share-btn').addEventListener('click', () => {
    navigator.clipboard?.writeText(window.location.href).then(() => toast('Link copied', 'success')).catch(() => toast('Could not copy link', 'error'));
  });
  document.getElementById('clear-queue-btn').addEventListener('click', clearQueue);
  document.getElementById('volume-slider').addEventListener('input', (e) => onVolumeInput(e.target.value));

  const searchInput = document.getElementById('search-input');
  document.getElementById('search-btn').addEventListener('click', submitSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSearch(); });

  // Initial paint from the REST endpoint while the WebSocket connects.
  api(`/api/guilds/${GUILD_ID}/player`).then(applyState).catch(() => {});
});
