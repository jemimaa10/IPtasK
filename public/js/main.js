import { api, bus, connectSocket, disconnectSocket } from './api.js';
import { store, app } from './state.js';
import { $, esc, avatar, colorFor, toast, ICONS } from './ui.js';
import { renderAuth } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderGroup } from './views/group.js';
import { renderNotifications } from './views/notifications.js';
import { renderProfile } from './views/profile.js';
import { openCreateGroup } from './views/home.js';

const root = $('#root');
let cleanup = null;

function shellHtml() {
  return `
  <div class="shell" id="shell">
    <aside class="sidebar">
      <a class="brand" href="#/home"><span class="brand-mark">iK</span><span class="brand-name">IPtas<b>K</b></span></a>
      <nav class="nav">
        <a href="#/home" data-route="home">${ICONS.home}Home</a>
        <a href="#/notifications" data-route="notifications">${ICONS.bell}Notifications<span class="badge" id="nav-unread" hidden></span></a>
        <a href="#/profile" data-route="profile">${ICONS.user}Profile</a>
      </nav>
      <div class="sidebar-label">Your groups <button id="nav-new-group" title="Create group">+</button></div>
      <div class="group-list" id="nav-groups"></div>
      <div class="sidebar-footer" id="nav-me"></div>
    </aside>
    <div>
      <div class="topbar">
        <button id="nav-toggle" aria-label="Menu">${ICONS.menu}</button>
        <a class="brand" href="#/home"><span class="brand-mark">iK</span><span class="brand-name">IPtas<b>K</b></span></a>
        <span class="badge" id="top-unread" hidden></span>
      </div>
      <main id="view"></main>
    </div>
  </div>`;
}

app.renderSidebar = () => {
  const route = parseRoute();
  const list = $('#nav-groups');
  if (!list) return;
  list.innerHTML = store.groups.length
    ? store.groups
        .map(
          (g) => `
      <a class="group-link ${route.name === 'group' && route.id === g.id ? 'active' : ''}" href="#/group/${g.id}/feed">
        <span class="group-dot" style="background:${colorFor(g.name + g.id)}">${esc(g.name[0].toUpperCase())}</span>
        <span class="name">${esc(g.name)}</span>
        ${g.myOpenMissions ? `<span class="badge" style="background:var(--amber);color:#111">${g.myOpenMissions}</span>` : ''}
      </a>`
        )
        .join('')
    : '<p style="color:var(--text-3);font-size:13px;padding:0 12px;margin:0">No groups yet.</p>';

  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route.name));
  $('#nav-me').innerHTML = `
    ${avatar(store.me, 36)}
    <div class="who"><b>${esc(store.me.displayName)}</b><small>@${esc(store.me.username)}</small></div>
    <button class="btn btn-ghost btn-sm" id="logout" title="Log out">${ICONS.logout}</button>`;
  $('#logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    disconnectSocket();
    store.me = null;
    location.hash = '#/login';
    start();
  };
};

app.refreshGroups = async () => {
  const { groups } = await api('/groups');
  store.groups = groups;
  app.renderSidebar();
};

app.refreshUnread = async () => {
  const { unread } = await api('/notifications');
  setUnread(unread);
};

function setUnread(n) {
  store.unread = n;
  for (const id of ['#nav-unread', '#top-unread']) {
    const b = $(id);
    if (!b) continue;
    b.hidden = n === 0;
    b.textContent = n > 99 ? '99+' : n;
  }
  document.title = n ? `(${n}) IPtasK` : 'IPtasK';
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'group' && parts[1]) return { name: 'group', id: Number(parts[1]), tab: parts[2] || 'feed' };
  if (['notifications', 'profile', 'home'].includes(parts[0])) return { name: parts[0] };
  if (['login', 'register'].includes(parts[0])) return { name: parts[0] };
  return { name: 'home' };
}

let lastGroupId = null;
function route() {
  if (!store.me) return;
  const r = parseRoute();
  if (r.name === 'login' || r.name === 'register') {
    location.hash = '#/home';
    return;
  }
  $('#shell')?.classList.remove('nav-open');
  app.renderSidebar();

  // Switching tabs inside the same group keeps the group view mounted.
  if (r.name === 'group' && lastGroupId === r.id && cleanup?.switchTab) {
    cleanup.switchTab(r.tab);
    return;
  }
  cleanup?.();
  cleanup = null;
  lastGroupId = r.name === 'group' ? r.id : null;
  const view = $('#view');
  view.innerHTML = '';
  window.scrollTo(0, 0);
  const renderers = { home: renderHome, notifications: renderNotifications, profile: renderProfile, group: renderGroup };
  cleanup = renderers[r.name](view, r) || null;
}

async function start() {
  cleanup?.();
  cleanup = null;
  lastGroupId = null;
  try {
    store.me = (await api('/auth/me')).user;
  } catch {
    store.me = null;
  }
  if (!store.me) {
    const r = parseRoute();
    renderAuth(root, r.name === 'register' ? 'register' : 'login');
    return;
  }
  root.innerHTML = shellHtml();
  $('#nav-toggle').onclick = () => $('#shell').classList.toggle('nav-open');
  $('#shell').addEventListener('click', (e) => {
    if (e.target.id === 'shell') $('#shell').classList.remove('nav-open');
  });
  $('#nav-new-group').onclick = () => openCreateGroup();
  $('#top-unread').onclick = () => (location.hash = '#/notifications');
  connectSocket();
  await Promise.all([app.refreshGroups(), app.refreshUnread()]);
  route();
}
app.start = start;

window.addEventListener('hashchange', () => {
  if (!store.me) {
    const r = parseRoute();
    if (r.name === 'login' || r.name === 'register') renderAuth(root, r.name);
    return;
  }
  route();
});

bus.on('notification', (n) => {
  setUnread(store.unread + 1);
  const go = () => n.link && (location.hash = n.link);
  toast(n.title, { body: n.body, onClick: go });
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const native = new Notification(`IPtasK — ${n.title}`, { body: n.body, icon: '/favicon.svg' });
    native.onclick = () => {
      window.focus();
      go();
    };
  }
  if (['mission', 'verified', 'invite_response', 'removed'].includes(n.type)) app.refreshGroups();
});

bus.on('group:deleted', ({ groupId }) => {
  app.refreshGroups();
  if (parseRoute().id === groupId) {
    toast('That group is no longer available.', { error: true });
    location.hash = '#/home';
  }
});

start();
