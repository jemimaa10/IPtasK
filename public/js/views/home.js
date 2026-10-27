import { api, bus } from '../api.js';
import { store, app } from '../state.js';
import { $, $$, esc, avatar, colorFor, countdown, fmtDate, statusPill, openModal, toast, busy } from '../ui.js';
import { openStory } from './confession.js';

export function openCreateGroup() {
  const { modal, close } = openModal(`
    <h2>Create a group</h2>
    <p class="sub">You'll be the leader: invite members, split the jobdesks, and set deadlines.</p>
    <form id="cg-form">
      <div class="field"><label>Group name</label><input class="input" name="name" maxlength="60" required placeholder="e.g. PBO Kelompok 3"></div>
      <div class="field"><label>Description <small>(optional)</small></label><textarea class="input" name="description" maxlength="300" placeholder="Course, project, goal…"></textarea></div>
      <div class="field">
        <label>Verification window</label>
        <select class="input" name="grace">
          <option value="12">12 hours after each deadline</option>
          <option value="24" selected>24 hours after each deadline</option>
          <option value="48">48 hours after each deadline</option>
          <option value="72">72 hours after each deadline</option>
        </select>
        <small>How long teammates have to press Checked after a deadline before IPtasK Bot exposes them.</small>
      </div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Create group</button></div>
    </form>`);
  const form = modal.querySelector('form');
  form.querySelector('[data-close]').onclick = close;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('.btn-primary'), async () => {
      try {
        const { group } = await api('/groups', {
          method: 'POST',
          body: { name: form.name.value, description: form.description.value, verifyGraceHours: Number(form.grace.value) },
        });
        close();
        await app.refreshGroups();
        location.hash = `#/group/${group.id}/members`;
        toast('Group created', { body: 'Now invite your teammates by username.' });
      } catch (err) {
        form.querySelector('.form-error').textContent = err.message;
      }
    });
  });
}

function missionRow(m, { review = false } = {}) {
  const cd = countdown(m.deadline);
  return `
    <a class="mission" href="#/group/${m.groupId}/${review ? 'feed' : 'missions'}" style="text-decoration:none">
      ${review ? avatar(m.assignee, 36) : `<span class="group-dot" style="background:${colorFor(m.groupName + m.groupId)}">${esc((m.groupName || '?')[0].toUpperCase())}</span>`}
      <div class="mission-main">
        <p class="mission-title">${esc(m.title)}</p>
        <div class="mission-meta">
          ${review ? `<span>by <b style="color:var(--text-2)">${esc(m.assignee.displayName)}</b></span>` : statusPill(m.status)}
          <span>${esc(m.groupName)}</span>
          ${review
            ? `<span class="countdown ${countdown(m.graceEnd).cls}">check within ${countdown(m.graceEnd).text.replace(' left', '')}</span>`
            : ['open', 'revision'].includes(m.status)
              ? `<span class="countdown ${cd.cls}">${cd.text}</span>`
              : `<span>${fmtDate(m.deadline)}</span>`}
        </div>
      </div>
      <span class="btn btn-sm">${review ? 'Review' : 'Open'}</span>
    </a>`;
}

export function renderHome(view) {
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Hi, ${esc(store.me.displayName)} 👋</h1>
          <p>Here's what your circles are counting on you for.</p>
        </div>
        <button class="btn btn-primary" id="home-new-group">+ New group</button>
      </div>
      <div id="home-stories"></div>
      <div id="home-invites"></div>
      <div class="section">
        <h2 class="section-title">Your jobdesks <span class="count" id="mine-count"></span></h2>
        <div id="home-mine"><div class="loading"><span class="spinner"></span></div></div>
      </div>
      <div class="section" id="home-review-wrap" hidden>
        <h2 class="section-title">Waiting for your check <span class="count" id="review-count"></span></h2>
        <div id="home-review"></div>
      </div>
      <div class="section">
        <h2 class="section-title">Your groups</h2>
        <div id="home-groups"></div>
      </div>
    </div>`;
  $('#home-new-group').onclick = openCreateGroup;

  let stories = [];

  async function loadStories() {
    stories = (await api('/stories')).stories;
    const box = $('#home-stories');
    if (!box) return;
    box.innerHTML = stories.length
      ? `<div class="section" style="margin-top:0">
          <h2 class="section-title">🔥 Wall of shame <span class="count">last 7 days</span></h2>
          <div class="stories">${stories
            .map((s, i) => `<button class="story" data-i="${i}"><span class="story-ring">${avatar(s.user, 58)}</span><span>${esc(s.user.displayName)}</span></button>`)
            .join('')}</div>
        </div>`
      : '';
    $$('.story', box).forEach((b) => (b.onclick = () => openStory(stories[Number(b.dataset.i)])));
  }

  async function loadInvites() {
    const { invites } = await api('/invites');
    const box = $('#home-invites');
    if (!box) return;
    box.innerHTML = invites.length
      ? `<div class="section" style="margin-top:${stories.length ? 24 : 0}px">
          <h2 class="section-title">Group invites</h2>
          <div class="card list-card">${invites
            .map((i) => `
              <div class="invite-row">
                ${avatar(i.inviter, 40)}
                <div class="grow"><b>${esc(i.groupName)}</b><small>Invited by ${esc(i.inviter.displayName)} (@${esc(i.inviter.username)})</small></div>
                <button class="btn btn-sm btn-ghost" data-decline="${i.id}">Decline</button>
                <button class="btn btn-sm btn-primary" data-accept="${i.id}">Join</button>
              </div>`)
            .join('')}</div>
        </div>`
      : '';
    $$('[data-accept],[data-decline]', box).forEach((b) => {
      b.onclick = () => busy(b, async () => {
        const accept = Boolean(b.dataset.accept);
        try {
          const res = await api(`/invites/${b.dataset.accept || b.dataset.decline}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
          await app.refreshGroups();
          if (accept) location.hash = `#/group/${res.groupId}/missions`;
          else loadInvites();
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    });
  }

  async function loadMissions() {
    const { missions, toReview } = await api('/me/missions');
    const mine = $('#home-mine');
    if (!mine) return;
    const active = missions.filter((m) => ['open', 'revision', 'submitted'].includes(m.status));
    const done = missions.filter((m) => !['open', 'revision', 'submitted'].includes(m.status));
    $('#mine-count').textContent = active.length ? `${active.length} active` : '';
    mine.innerHTML = missions.length
      ? `<div class="card list-card">${[...active, ...done].map((m) => missionRow(m)).join('')}</div>`
      : '<div class="empty"><b>No jobdesks yet</b>When your group leader assigns you a mission, it shows up here.</div>';
    $('#home-review-wrap').hidden = toReview.length === 0;
    $('#review-count').textContent = toReview.length ? `${toReview.length} pending` : '';
    $('#home-review').innerHTML = `<div class="card list-card">${toReview.map((m) => missionRow(m, { review: true })).join('')}</div>`;
  }

  function renderGroups() {
    const box = $('#home-groups');
    if (!box) return;
    box.innerHTML = store.groups.length
      ? `<div class="grid-2">${store.groups
          .map((g) => `
            <a class="card group-card" href="#/group/${g.id}/feed">
              <div style="display:flex;gap:12px;align-items:center">
                <span class="group-dot" style="width:40px;height:40px;font-size:17px;background:${colorFor(g.name + g.id)}">${esc(g.name[0].toUpperCase())}</span>
                <div style="min-width:0"><h3>${esc(g.name)}</h3><p>${esc(g.lastMessage || g.description || 'No messages yet')}</p></div>
              </div>
              <div class="meta">
                <span>👥 ${g.memberCount} member${g.memberCount > 1 ? 's' : ''}</span>
                ${g.isLeader ? '<span class="pill leader">Leader</span>' : ''}
                ${g.myOpenMissions ? `<span class="pill submitted">${g.myOpenMissions} to do</span>` : ''}
              </div>
            </a>`)
          .join('')}</div>`
      : `<div class="empty"><b>You're not in any group yet</b>Create one as a leader, or ask your leader to invite <b style="display:inline;color:var(--lime)">@${esc(store.me.username)}</b>.</div>`;
  }

  renderGroups();
  loadStories().then(loadInvites);
  loadMissions();

  const offs = [
    bus.on('invites:changed', loadInvites),
    bus.on('notification', (n) => {
      if (['mission', 'proof', 'checked', 'revision', 'verified', 'confession', 'deadline_h1'].includes(n.type)) loadMissions();
      if (n.type === 'confession') loadStories();
      if (n.type === 'invite') loadInvites();
    }),
  ];
  const timer = setInterval(() => app.refreshGroups().then(renderGroups), 30000);
  return () => {
    offs.forEach((off) => off());
    clearInterval(timer);
  };
}
