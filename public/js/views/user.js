import { api } from '../api.js';
import { store } from '../state.js';
import { esc, avatar, toast } from '../ui.js';
import { statsHtml } from './profile.js';
import { labelCard, labelChips, bindLabelActions } from './labels.js';

/** Someone's public profile: labels first, because everyone is meant to see them. */
export function renderUser(view, route) {
  let alive = true;
  view.innerHTML = '<div class="loading"><span class="spinner"></span></div>';

  async function load() {
    const { user, labels, stats } = await api(`/users/${route.id}`);
    if (!alive) return;
    view.innerHTML = `
      <div class="page" style="max-width:640px">
        <div class="public-head">
          ${avatar(user, 88)}
          <div style="min-width:0">
            <h1>${esc(user.displayName)}</h1>
            <p>@${esc(user.username)}${user.id === store.me.id ? ' · this is how others see you · <a href="#/profile">edit profile</a>' : ''}</p>
            ${labelChips(labels)}
          </div>
        </div>
        ${labels.length
          ? `<div class="section">
               <h2 class="section-title">Labels <span class="count">${labels.length}</span></h2>
               <div class="beban-list">${labels.map((l) => labelCard(l)).join('')}</div>
             </div>`
          : '<div class="section"><div class="empty"><b>No labels</b>This person has finished every jobdesk so far.</div></div>'}
        <div class="section">
          <h2 class="section-title">Track record</h2>
          ${statsHtml(stats, { own: false })}
        </div>
      </div>`;
    bindLabelActions(view, load);
  }

  load().catch((err) => {
    toast(err.message, { error: true });
    location.hash = '#/home';
  });
  return () => {
    alive = false;
  };
}
