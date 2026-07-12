/* ==========================================================================
   Home dashboard ("Your servers", Recently Played, Library, charts).

   Backed by real endpoints where they exist in app.py:
     GET /api/guilds        -> servers row

   The reference design also calls for Recently Played, a Library
   (playlists/favourites), Trending Now, and Your Most Played — none of
   which have a backend endpoint in app.py yet. Those are implemented as
   honest, clearly-labelled local (per-browser) features for now:

     - Recently Played / Your Most Played: built from localStorage,
       written to by player.js as you actually listen.
     - Playlists: a small local playlist list (name only), stored the
       same way, so "Create Playlist" isn't a dead button.
     - Trending Now: needs real cross-server aggregation, which can't be
       faked honestly client-side, so it shows an explanatory empty
       state. Swap in a real `GET /api/charts/trending` and this file
       will pick it up automatically (see loadTrending below).
   ========================================================================== */

const LS_RECENT = 'Maya:recentlyPlayed';
const LS_MOST_PLAYED = 'Maya:mostPlayed';
const LS_PLAYLISTS = 'Maya:playlists';
const LS_FAVOURITES = 'Maya:favourites';

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

/* ── Your servers ─────────────────────────────────────────────────── */

async function loadServers() {
  const row = document.getElementById('servers-row');
  if (!row) return;
  let guilds;
  try {
    const data = await api('/api/guilds');
    guilds = data.guilds;
  } catch (err) {
    row.innerHTML = `<div class="empty-state"><div class="title">Couldn't load your servers</div><div class="hint">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  if (!guilds.length) {
    row.innerHTML = `<div class="empty-state">
      <div class="title">No servers yet</div>
      <div class="hint">Add Maya to a server to see it here.</div>
    </div>`;
    return;
  }

  row.innerHTML = guilds.map((g) => `
    <a class="tile" href="/dashboard/${g.id}" data-guild-id="${g.id}">
      <div class="tile-art">
        ${g.icon ? `<img src="${g.icon}" alt="" loading="lazy">` : `<span class="initials">${escapeHtml(initials(g.name))}</span>`}
        ${g.is_playing ? '<span class="live-dot" title="Playing now"></span>' : ''}
      </div>
      <div class="tile-label">${escapeHtml(g.name)}</div>
      <div class="tile-sub">${g.member_count.toLocaleString()} members</div>
    </a>
  `).join('');
}

/* ── Recently played (local) ─────────────────────────────────────── */

function loadRecentlyPlayed() {
  const row = document.getElementById('recent-row');
  if (!row) return;
  const recents = readLS(LS_RECENT, []).slice(0, 10);

  if (!recents.length) {
    row.innerHTML = `<div class="empty-state">
      <div class="title">Nothing played yet</div>
      <div class="hint">Servers you open the player for will show up here.</div>
    </div>`;
    return;
  }

  row.innerHTML = recents.map((r) => `
    <a class="tile rp" href="/dashboard/${r.id}">
      <div class="tile-art">
        ${r.icon ? `<img src="${r.icon}" alt="" loading="lazy">` : `<span class="initials">${escapeHtml(initials(r.name))}</span>`}
      </div>
      <div class="tile-label">${escapeHtml(r.name)}</div>
    </a>
  `).join('');
}

/* ── Library: playlists / favourites (local) ─────────────────────── */

function renderPlaylists() {
  const body = document.getElementById('library-body');
  const playlists = readLS(LS_PLAYLISTS, []);
  if (!playlists.length) {
    body.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <div class="title">No playlists to organize</div>
      <div class="hint">Create your first playlist to organize your music.</div>
      <button class="btn btn-primary btn-sm" id="create-playlist-empty">+ Create playlist</button>
    </div>`;
    document.getElementById('create-playlist-empty')?.addEventListener('click', promptCreatePlaylist);
    return;
  }
  body.innerHTML = `<div class="playlist-grid">${playlists.map((p) => `
    <div class="playlist-card">
      <div class="pl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="pl-name">${escapeHtml(p.name)}</div>
      <div class="pl-count">${(p.trackCount || 0)} tracks</div>
    </div>
  `).join('')}</div>`;
}

function renderFavourites() {
  const body = document.getElementById('library-body');
  const favs = readLS(LS_FAVOURITES, []);
  if (!favs.length) {
    body.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
      <div class="title">No favourites yet</div>
      <div class="hint">Tap the heart on a track in the player to save it here.</div>
    </div>`;
    return;
  }
  body.innerHTML = `<div class="playlist-grid">${favs.slice(0, 12).map((t) => `
    <div class="playlist-card">
      <div class="pl-name">${escapeHtml(t.title)}</div>
      <div class="pl-count">${escapeHtml(t.author || '')}</div>
    </div>
  `).join('')}</div>`;
}

function promptCreatePlaylist() {
  const name = window.prompt('Name your playlist');
  if (!name || !name.trim()) return;
  const playlists = readLS(LS_PLAYLISTS, []);
  playlists.unshift({ id: `pl_${Date.now()}`, name: name.trim(), trackCount: 0, createdAt: Date.now() });
  writeLS(LS_PLAYLISTS, playlists);
  toast('Playlist created', 'success');
  renderPlaylists();
}

function initLibrary() {
  const tabs = document.querySelectorAll('.library-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'favourites') renderFavourites();
      else renderPlaylists();
    });
  });
  document.getElementById('create-playlist-btn')?.addEventListener('click', promptCreatePlaylist);
  renderPlaylists();
}

/* ── Trending Now (needs a real backend endpoint) ─────────────────── */

async function loadTrending() {
  const el = document.getElementById('trending-list');
  if (!el) return;
  try {
    // If/when a real endpoint exists, this will render it automatically.
    const data = await api('/api/charts/trending');
    renderChartList(el, data.tracks || []);
  } catch {
    el.innerHTML = `<div class="empty-state">
      <div class="title">No trending data yet</div>
      <div class="hint">This needs a server-wide listening endpoint that isn't wired up yet.</div>
    </div>`;
  }
}

/* ── Your Most Played (local tally, written by player.js) ─────────── */

function loadMostPlayed() {
  const el = document.getElementById('most-played-list');
  if (!el) return;
  const map = readLS(LS_MOST_PLAYED, {});
  const tracks = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 8);
  if (!tracks.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="title">Nothing tracked yet</div>
      <div class="hint">Play something in one of your servers and it'll show up here.</div>
    </div>`;
    return;
  }
  renderChartList(el, tracks);
}

function renderChartList(el, tracks) {
  if (!tracks.length) {
    el.innerHTML = `<div class="empty-state"><div class="title">Nothing here yet</div></div>`;
    return;
  }
  el.innerHTML = tracks.map((t, i) => `
    <div class="chart-row">
      <div class="chart-rank">${String(i + 1).padStart(2, '0')}</div>
      ${t.thumbnail ? `<img class="chart-art" src="${t.thumbnail}" alt="" loading="lazy">` : '<div class="chart-art"></div>'}
      <div class="chart-info">
        <div class="chart-title">${escapeHtml(t.title)}</div>
        <div class="chart-sub">${escapeHtml(t.author || '')}</div>
      </div>
      <div class="chart-meta">${t.count ? `${t.count}×` : formatDuration(t.duration)}</div>
    </div>
  `).join('');
}

/* ── Add to server ─────────────────────────────────────────────────── */

function initAddToServer() {
  const btn = document.getElementById('add-to-server-btn');
  if (!btn) return;
  if (!btn.dataset.inviteUrl) {
    btn.addEventListener('click', () => toast('Invite link isn\u2019t configured yet.'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadServers();
  loadRecentlyPlayed();
  initLibrary();
  loadTrending();
  loadMostPlayed();
  initAddToServer();
});
