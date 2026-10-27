import { api, bus } from '../api.js';
import { app } from '../state.js';
import { $, $$, esc, avatar, timeAgo, toast } from '../ui.js';

const ICON = {
  revision: '✎', checked: '✓', verified: '🎉', proof: '📎', confession: '🤖', mission: '📌',
  deadline_h1: '⏰', daily: '📅', review_reminder: '👀', invite: '✉️', invite_response: '👥', removed: '🚪',
};

export function renderNotifications(view) {
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>Notifications</h1><p>Revisions, checks, deadlines, and IPtasK Bot posts.</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn" id="n-push">🔔 Enable desktop alerts</button>' : ''}
          <button class="btn" id="n-read">Mark all as read</button>
        </div>
      </div>
      <div id="n-list"><div class="loading"><span class="spinner"></span></div></div>
    </div>`;
  let items = [];

  async function load() {
    const data = await api('/notifications');
    items = data.notifications;
    const list = $('#n-list', view);
    if (!list) return;
    list.innerHTML = items.length
      ? `<div class="card list-card">${items
          .map((n) => `
            <div class="notif ${n.isRead ? '' : 'unread'}" data-id="${n.id}">
              ${n.actor ? avatar(n.actor, 36) : `<span class="notif-icon">${ICON[n.type] || '•'}</span>`}
              <div style="flex:1;min-width:0">
                <b>${n.actor ? `${ICON[n.type] || ''} ` : ''}${esc(n.title)}</b>
                ${n.body ? `<p>${esc(n.body)}</p>` : ''}
                <time>${timeAgo(n.createdAt)}</time>
              </div>
            </div>`)
          .join('')}</div>`
      : '<div class="empty"><b>All quiet</b>Nothing here yet.</div>';
    $$('.notif', list).forEach((row) => (row.onclick = async () => {
      const n = items.find((x) => x.id === Number(row.dataset.id));
      if (!n.isRead) {
        await api(`/notifications/${n.id}/read`, { method: 'POST' });
        app.refreshUnread();
      }
      if (n.link) location.hash = n.link;
      else load();
    }));
  }

  $('#n-read', view).onclick = async () => {
    await api('/notifications/read-all', { method: 'POST' });
    app.refreshUnread();
    load();
  };
  const push = $('#n-push', view);
  if (push) {
    push.onclick = async () => {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        push.remove();
        toast('Desktop alerts enabled', { body: 'You will get alerts while IPtasK is open in a tab.' });
      }
    };
  }

  load().catch((err) => toast(err.message, { error: true }));
  return bus.on('notification', load);
}
