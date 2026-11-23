// Discord-style card that pops up above the profile in the bottom-left of the sidebar:
// photo, name and the three headline stats, plus shortcuts to the profile and Log out.
import { api } from './api.js';
import { store, app } from './state.js';
import { esc, avatar, colorFor } from './ui.js';

let card = null;

export function closeMeCard() {
  if (!card) return;
  card.remove();
  card = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('hashchange', closeMeCard);
  window.removeEventListener('resize', closeMeCard);
  document.querySelector('#me-card-btn')?.setAttribute('aria-expanded', 'false');
}

function onOutside(e) {
  if (card?.contains(e.target) || e.target.closest?.('#me-card-btn')) return;
  closeMeCard();
}
function onKey(e) {
  if (e.key === 'Escape') {
    closeMeCard();
    document.querySelector('#me-card-btn')?.focus();
  }
}

const statTile = (value, label, tone = '') => `<div class="me-stat ${tone}"><b>${value}</b><span>${label}</span></div>`;

function statsHtml(st) {
  if (!st) return `${statTile('…', 'day streak')}${statTile('…', 'on time')}${statTile('…', 'jobdesks done')}`;
  return `
    ${statTile(`🔥 ${st.streak.current}`, `day streak${st.streak.best ? ` · best ${st.streak.best}` : ''}`, 'accent')}
    ${statTile(st.completionRate == null ? '—' : `${st.completionRate}%`, 'on time')}
    ${statTile(st.verified, 'jobdesks done', 'green')}`;
}

export function toggleMeCard(anchor) {
  if (card) return closeMeCard();
  const me = store.me;
  card = document.createElement('div');
  card.className = 'me-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Your profile');
  card.innerHTML = `
    <div class="me-card-banner" style="background:${colorFor(me.username)}"></div>
    <div class="me-card-photo">${avatar(me, 76)}</div>
    <div class="me-card-body">
      <div class="me-card-name"><b>${esc(me.displayName)}</b><small>@${esc(me.username)}</small></div>
      <div class="me-card-stats" aria-live="polite">${statsHtml(null)}</div>
      <div class="me-card-menu">
        <a href="#/profile">Edit profile</a>
        <a href="#/user/${me.id}">View public profile</a>
      </div>
      <button type="button" class="me-card-logout">Log out</button>
    </div>`;
  document.body.appendChild(card);

  // Above the profile row, lined up with the sidebar's left edge.
  const r = anchor.getBoundingClientRect();
  card.style.left = `${Math.max(8, r.left)}px`;
  card.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;

  card.querySelectorAll('.me-card-menu a').forEach((a) => a.addEventListener('click', closeMeCard));
  card.querySelector('.me-card-logout').onclick = () => {
    closeMeCard();
    app.logout();
  };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', closeMeCard);
  window.addEventListener('resize', closeMeCard);
  anchor.setAttribute('aria-expanded', 'true');

  const opened = card;
  api('/me/stats')
    .then((st) => {
      if (card === opened) card.querySelector('.me-card-stats').innerHTML = statsHtml(st);
    })
    .catch(() => {
      if (card === opened) card.querySelector('.me-card-stats').innerHTML = '<small class="me-card-error">Stats could not be loaded.</small>';
    });
}
