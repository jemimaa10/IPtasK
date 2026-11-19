import { api, bus, connectSocket, disconnectSocket } from './api.js';
import { store, app } from './state.js';
import { $, $$, esc, avatar, colorFor, toast, openModal, ICONS } from './ui.js';
import { renderAuth } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderGroup } from './views/group.js';
import { renderNotifications } from './views/notifications.js';
import { renderProfile } from './views/profile.js';
import { renderUser } from './views/user.js';
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
        <a class="brand" href="#/home"><span class="brand-mark">iK</span><span class="brand-name">IPtas<b>K</b></span></a>
      </div>
      <main id="view"></main>
    </div>
    <nav class="bottom-nav" aria-label="Main">
      <a href="#/home" data-tab="home">${ICONS.home}<span>Home</span></a>
      <button type="button" data-tab="group" id="bn-groups">${ICONS.groups}<span>Groups</span></button>
      <button type="button" class="bn-create" id="bn-create" aria-label="Create group">${ICONS.plus}</button>
      <a href="#/notifications" data-tab="notifications">${ICONS.bell}<span>Alerts</span><span class="badge" id="bn-unread" hidden></span></a>
      <a href="#/profile" data-tab="profile">${ICONS.user}<span>Profile</span></a>
    </nav>
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
  $$('.bottom-nav [data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === route.name));
  $('#nav-me').innerHTML = `
    ${avatar(store.me, 36)}
    <div class="who"><b>${esc(store.me.displayName)}</b><small>@${esc(store.me.username)}</small></div>
    <button class="btn btn-ghost btn-sm" id="logout" title="Log out">${ICONS.logout}</button>`;
  $('#logout').onclick = app.logout;
};

/** Mobile: the sidebar's group list, as a bottom sheet. */
function openGroupSheet() {
  const current = parseRoute();
  const { modal, close } = openModal(`
    <h2>Your groups</h2>
    <div class="sheet-list">${store.groups.length
      ? store.groups.map((g) => `
        <a class="group-link ${current.name === 'group' && current.id === g.id ? 'active' : ''}" href="#/group/${g.id}/feed">
          <span class="group-dot" style="background:${colorFor(g.name + g.id)}">${esc(g.name[0].toUpperCase())}</span>
          <span class="name">${esc(g.name)}</span>
          ${g.myOpenMissions ? `<span class="badge" style="background:var(--amber);color:#111">${g.myOpenMissions}</span>` : ''}
        </a>`).join('')
      : '<p style="color:var(--text-3);margin:8px 0">No groups yet. Create one, or wait for an invite.</p>'}
    </div>
    <button class="btn btn-primary btn-block" data-new>${ICONS.plus} Create group</button>`, { className: 'sheet' });
  $$('a', modal).forEach((a) => a.addEventListener('click', close));
  modal.querySelector('[data-new]').onclick = () => {
    close();
    openCreateGroup();
  };
}

app.logout = async () => {
  await api('/auth/logout', { method: 'POST' });
  disconnectSocket();
  store.me = null;
  location.hash = '#/login';
  start();
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
  for (const id of ['#nav-unread', '#bn-unread']) {
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
  if (parts[0] === 'user' && parts[1]) return { name: 'user', id: Number(parts[1]) };
  if (['notifications', 'profile', 'home'].includes(parts[0])) return { name: parts[0] };
  if (['login', 'register', 'recover'].includes(parts[0])) return { name: parts[0] };
  return { name: 'home' };
}

let lastGroupId = null;
function route() {
  if (!store.me) return;
  const r = parseRoute();
  if (['login', 'register', 'recover'].includes(r.name)) {
    location.hash = '#/home';
    return;
  }
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
  const renderers = { home: renderHome, notifications: renderNotifications, profile: renderProfile, group: renderGroup, user: renderUser };
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
    renderAuth(root, ['register', 'recover'].includes(r.name) ? r.name : 'login');
    return;
  }
  root.innerHTML = shellHtml();
  $('#nav-new-group').onclick = () => openCreateGroup();
  $('#bn-create').onclick = () => openCreateGroup();
  $('#bn-groups').onclick = openGroupSheet;
  connectSocket();
  await Promise.all([app.refreshGroups(), app.refreshUnread()]);
  route();
}
app.start = start;

window.addEventListener('hashchange', () => {
  if (!store.me) {
    const r = parseRoute();
    if (['login', 'register', 'recover'].includes(r.name)) renderAuth(root, r.name);
    return;
  }
  route();
});

bus.on('notification', (n) => {
  setUnread(store.unread + 1);
  const go = () => n.link && (location.hash = n.link);
  toast(n.title, { body: n.body, onClick: go });
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') showNative(n, go);
  if (['mission', 'verified', 'invite_response', 'removed', 'leader', 'label', 'redeem'].includes(n.type)) app.refreshGroups();
});

/** Through the service worker when possible: `new Notification()` is not allowed on Android. */
async function showNative(n, go) {
  const title = `IPtasK — ${n.title}`;
  const options = { body: n.body, icon: '/icon.svg', tag: `n${n.id}`, data: { link: n.link } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, options);
  } catch {
    // fall through to the page-level notification
  }
  const native = new Notification(title, options);
  native.onclick = () => {
    window.focus();
    go();
  };
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.link) location.hash = e.data.link;
  });
}

bus.on('group:deleted', ({ groupId }) => {
  app.refreshGroups();
  if (parseRoute().id === groupId) {
    toast('That group is no longer available.', { error: true });
    location.hash = '#/home';
  }
});

start();
