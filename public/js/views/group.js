import { api, bus, joinGroupRoom } from '../api.js';
import { $, $$, esc, avatar, groupDot, toast } from '../ui.js';
import { app } from '../state.js';

const CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';
import { renderFeed } from './group-feed.js';
import { renderChat } from './group-chat.js';
import { renderMissions } from './group-missions.js';
import { renderMembers } from './group-members.js';
import { editGroupPhoto } from '../group-look.js';

const TABS = {
  feed: { label: 'Proof feed', render: renderFeed },
  chat: { label: 'Chat', render: renderChat },
  missions: { label: 'Missions', render: renderMissions },
  members: { label: 'Members', render: renderMembers },
};

export function renderGroup(view, route) {
  const groupId = route.id;
  let tab = TABS[route.tab] ? route.tab : 'feed';
  let tabCleanup = null;
  let alive = true;
  const ctx = { groupId, group: null, members: [], pendingInvites: [], aiEnabled: false, reload: null };

  const leaveRoom = joinGroupRoom(groupId);
  view.innerHTML = '<div class="loading"><span class="spinner"></span></div>';

  async function load() {
    const data = await api(`/groups/${groupId}`);
    Object.assign(ctx, {
      group: data.group,
      members: data.members,
      pendingInvites: data.pendingInvites,
      aiEnabled: data.aiEnabled,
      isLeader: data.group.isLeader,
    });
  }
  ctx.reload = async () => {
    await load();
    renderHeader();
  };

  function renderHeader() {
    const g = ctx.group;
    const head = $('#group-head', view);
    head.innerHTML = `
      <div class="group-title-row">
        ${ctx.isLeader
          ? `<button type="button" class="group-photo-edit" data-edit="avatar" title="${g.avatarUrl ? 'Change' : 'Add'} group photo">${groupDot(g, 42)}<span class="cam">${CAMERA}</span></button>`
          : groupDot(g, 42)}
        <div style="min-width:0">
          <h1>${esc(g.name)}</h1>
          <p>${ctx.members.length} member${ctx.members.length > 1 ? 's' : ''}${g.description ? ` · ${esc(g.description)}` : ''}</p>
        </div>
        <div class="avatar-stack">${ctx.members.slice(0, 6).map((m) => avatar(m, 32)).join('')}</div>
      </div>
      <nav class="tabs">${Object.entries(TABS)
        .map(([key, t]) => `<a href="#/group/${groupId}/${key}" data-tab="${key}" class="${key === tab ? 'active' : ''}">${t.label}</a>`)
        .join('')}</nav>`;
    // Leader: tap the photo to add, change or remove it.
    const photo = $('[data-edit]', head);
    if (photo) {
      photo.onclick = async () => {
        if (!(await editGroupPhoto(ctx.group))) return;
        await ctx.reload();
        app.refreshGroups();
      };
    }
  }

  function mountTab() {
    tabCleanup?.();
    const body = $('#group-tab', view);
    body.innerHTML = '';
    body.className = tab === 'chat' ? '' : 'group-body';
    tabCleanup = TABS[tab].render(body, ctx) || null;
  }

  load()
    .then(() => {
      if (!alive) return;
      view.innerHTML = `
        <header class="group-header"><div class="group-header-inner" id="group-head"></div></header>
        <div id="group-tab"></div>`;
      renderHeader();
      mountTab();
    })
    .catch((err) => {
      if (!alive) return;
      toast(err.message, { error: true });
      location.hash = '#/home';
    });

  const offChanged = bus.on('group:changed', async () => {
    await ctx.reload();
    if (tab === 'members' || tab === 'missions') mountTab();
  });

  const cleanup = () => {
    alive = false;
    tabCleanup?.();
    offChanged();
    leaveRoom();
  };
  cleanup.switchTab = (next) => {
    if (!TABS[next] || !ctx.group) return;
    tab = next;
    $$('.tabs a', view).forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    mountTab();
  };
  return cleanup;
}
