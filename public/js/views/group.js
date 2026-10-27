import { api, bus, joinGroupRoom } from '../api.js';
import { $, $$, esc, avatar, colorFor, toast } from '../ui.js';
import { renderFeed } from './group-feed.js';
import { renderChat } from './group-chat.js';
import { renderMissions } from './group-missions.js';
import { renderMembers } from './group-members.js';

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
        <span class="group-dot" style="width:42px;height:42px;font-size:18px;background:${colorFor(g.name + g.id)}">${esc(g.name[0].toUpperCase())}</span>
        <div style="min-width:0">
          <h1>${esc(g.name)}</h1>
          <p>${ctx.members.length} member${ctx.members.length > 1 ? 's' : ''}${g.description ? ` · ${esc(g.description)}` : ''}</p>
        </div>
        <div class="avatar-stack">${ctx.members.slice(0, 6).map((m) => avatar(m, 32)).join('')}</div>
      </div>
      <nav class="tabs">${Object.entries(TABS)
        .map(([key, t]) => `<a href="#/group/${groupId}/${key}" data-tab="${key}" class="${key === tab ? 'active' : ''}">${t.label}</a>`)
        .join('')}</nav>`;
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
