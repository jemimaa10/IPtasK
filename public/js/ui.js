export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- avatars ----------

const PALETTE = ['#a8d8bc', '#8b6cff', '#ff8fa3', '#4ea8ff', '#ffb547', '#3ddc97', '#ff6bd6', '#5eead4'];
export function colorFor(seed = '') {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function initials(name = '?') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

/** Uploaded photo, or the default initials avatar when none is set. */
export function avatar(user, size = 40) {
  if (!user) return `<span class="avatar" style="width:${size}px;height:${size}px"></span>`;
  if (user.avatarUrl) {
    return `<img class="avatar" src="${esc(user.avatarUrl)}" alt="${esc(user.displayName)}" style="width:${size}px;height:${size}px">`;
  }
  return `<span class="avatar" title="${esc(user.displayName)}" style="width:${size}px;height:${size}px;background:${colorFor(user.username)};font-size:${Math.round(size * 0.4)}px">${esc(initials(user.displayName))}</span>`;
}

// ---------- time ----------

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** "in 2d 4h" style countdown with an urgency class. */
export function countdown(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) return { text: 'deadline passed', cls: 'urgent' };
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  const text = d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${min}m left` : `${min}m left`;
  return { text, cls: ms < 86400000 ? 'urgent' : ms < 3 * 86400000 ? 'soon' : '' };
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const STATUS_LABEL = {
  open: 'Not uploaded',
  submitted: 'Waiting for checks',
  revision: 'Needs revision',
  verified: 'Verified',
  failed: 'Missed deadline',
  unverified: 'Not verified',
};
export const statusPill = (status) => `<span class="pill ${status}">${STATUS_LABEL[status] || status}</span>`;

// ---------- toast & modal ----------

export function toast(title, { body = '', error = false, onClick } = {}) {
  const node = el(`<div class="toast ${error ? 'error' : ''}"><b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}</div>`);
  node.addEventListener('click', () => {
    onClick?.();
    node.remove();
  });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 5000);
}

export function openModal(html, { wide = false, className = '' } = {}) {
  const backdrop = el(`<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''} ${className}">${html}</div></div>`);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  $$('[data-close]', backdrop).forEach((b) => b.addEventListener('click', close));
  const modal = backdrop.firstElementChild;
  modal.querySelector('input, textarea, select')?.focus();
  return { modal, close };
}

export function confirmDialog(title, body, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const { modal, close } = openModal(`
      <h2>${esc(title)}</h2>
      <p class="sub">${esc(body)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>
      </div>`);
    let ok = false;
    modal.querySelector('[data-ok]').addEventListener('click', () => {
      ok = true;
      close();
    });
    new MutationObserver((_, obs) => {
      if (!modal.isConnected) {
        obs.disconnect();
        resolve(ok);
      }
    }).observe($('#modal-root'), { childList: true });
  });
}

/** Disable a button and show a spinner while an async action runs. */
export async function busy(button, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    return await fn();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  groups: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  menu: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  logout: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
};

/** Reminder frequency for unfinished jobdesks, in days (0 = off). Must match REMINDER_CHOICES on the server. */
export const REMINDER_OPTIONS = [
  [1, 'Every day'],
  [2, 'Every 2 days'],
  [3, 'Every 3 days'],
  [7, 'Every week'],
  [0, 'No reminders'],
];

export function reminderLabel(days) {
  return (REMINDER_OPTIONS.find(([d]) => d === days) || [, `Every ${days} days`])[1];
}

/**
 * <select> for the reminder frequency. With `groupDefault` set, the first option is
 * "Group default (…)" (value "group"), and `selected` null picks it.
 */
export function reminderSelect(name, selected, { groupDefault = null } = {}) {
  const opts = REMINDER_OPTIONS.map(
    ([d, label]) => `<option value="${d}" ${selected === d ? 'selected' : ''}>${label}</option>`
  ).join('');
  const group = groupDefault === null
    ? ''
    : `<option value="group" ${selected === null || selected === undefined ? 'selected' : ''}>Group default (${reminderLabel(groupDefault).toLowerCase()})</option>`;
  return `<select class="input" name="${name}">${group}${opts}</select>`;
}

/** One-time error from a redirect (e.g. Google sign-in): read it, then drop it from the address bar. */
export function takeAuthError() {
  const params = new URLSearchParams(location.search);
  const msg = params.get('auth_error');
  if (msg) history.replaceState(null, '', location.pathname + location.hash);
  return msg;
}

const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

export function googleButton(label, href = '/api/auth/google') {
  return `<a class="btn btn-block btn-lg btn-google" href="${href}">${GOOGLE_G}<span>${label}</span></a>`;
}
