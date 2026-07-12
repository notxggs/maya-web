/* ==========================================================================
   Maya — shared front-end helpers used by both the home dashboard
   and the per-guild player page.
   ========================================================================== */

/** Show a toast in the bottom-right corner. type: 'default' | 'success' | 'error' */
function toast(message, type = 'default', ms = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${type !== 'default' ? ' ' + type : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.2s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, ms);
}

/**
 * Thin wrapper around fetch() for our JSON API.
 * - Sends/receives JSON automatically.
 * - On 401 (session expired / logged out), bounces to the login page.
 * - Throws an Error with the server's `detail` message on non-2xx so
 *   callers can toast() it.
 */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    window.location.href = '/';
    throw new Error('Not logged in');
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    const message = (data && data.detail) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

/** mm:ss formatter for track durations / position (input in ms). */
function formatDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** "Good morning / afternoon / evening" for the dashboard greeting. */
function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Sprinkle a handful of ambient falling petals into .petal-field. */
function initPetals(count = 14) {
  const field = document.querySelector('.petal-field');
  if (!field) return;
  const glyphs = ['✿', '❀', '❁'];
  for (let i = 0; i < count; i++) {
    const petal = document.createElement('span');
    petal.className = 'petal';
    petal.textContent = glyphs[i % glyphs.length];
    petal.style.left = `${Math.random() * 100}%`;
    petal.style.setProperty('--drift', `${(Math.random() - 0.5) * 120}px`);
    petal.style.animationDuration = `${12 + Math.random() * 10}s`;
    petal.style.animationDelay = `${Math.random() * 12}s`;
    petal.style.fontSize = `${10 + Math.random() * 10}px`;
    field.appendChild(petal);
  }
}

/** Wire up the user avatar dropdown (logout link etc.) in the top nav. */
function initNavUser() {
  const trigger = document.getElementById('nav-user-trigger');
  const menu = document.getElementById('nav-user-menu');
  if (!trigger || !menu) return;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

document.addEventListener('DOMContentLoaded', () => {
  initPetals();
  initNavUser();
});
