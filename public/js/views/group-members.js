import { api } from '../api.js';
import { store, app } from '../state.js';
import { $, $$, esc, avatar, confirmDialog, toast, busy, reminderSelect } from '../ui.js';
import { labelCard, labelChips, bindLabelActions } from './labels.js';

function leaderboardHtml(rows) {
  if (!rows) return '<div class="loading"><span class="spinner"></span></div>';
  const medal = ['🥇', '🥈', '🥉'];
  return `<div class="card list-card">${rows
    .map((r, i) => `
      <div class="invite-row lb-row">
        <span class="lb-rank">${medal[i] || i + 1}</span>
        ${avatar(r.user, 36)}
        <div class="grow"><a class="user-link" href="#/user/${r.user.id}"><b>${esc(r.user.displayName)}${r.user.id === store.me.id ? ' (you)' : ''}</b></a>
          <span data-label-for="${r.user.id}"></span>
          <small>${r.completionRate == null ? 'No finished missions yet' : `${r.completionRate}% on time`} · 🔥 ${r.streak} day${r.streak === 1 ? '' : 's'}</small></div>
        <span class="pill verified" title="Verified missions">✓ ${r.verified}</span>
        <span class="pill failed" title="Failed or unverified missions">✗ ${r.failed + r.unverified}</span>
        <span class="pill" title="Confessions posted by IPtasK Bot">🤖 ${r.confessions}</span>
      </div>`)
    .join('')}</div>`;
}

export function renderMembers(container, ctx) {
  const g = ctx.group;
  container.innerHTML = `
    <div class="section" style="margin-top:0">
      <h2 class="section-title">Leaderboard</h2>
      <div id="lb">${leaderboardHtml(null)}</div>
    </div>
    <div id="labels-section"></div>`;
  container.insertAdjacentHTML('beforeend', `
    ${ctx.isLeader ? `
    <div class="section">
      <h2 class="section-title">Invite members</h2>
      <form class="card" id="inv-form">
        <div style="display:flex;gap:10px">
          <div class="suggest" style="flex:1">
            <input class="input" name="username" autocomplete="off" placeholder="Search by username…" required>
            <div class="suggest-list" id="inv-suggest" hidden></div>
          </div>
          <button class="btn btn-primary">Invite</button>
        </div>
        <div class="form-error" style="margin-bottom:0"></div>
      </form>
    </div>` : ''}
    ${ctx.isLeader && ctx.pendingInvites.length ? `
    <div class="section">
      <h2 class="section-title">Pending invites <span class="count">${ctx.pendingInvites.length}</span></h2>
      <div class="card list-card">${ctx.pendingInvites
        .map((i) => `
          <div class="invite-row">${avatar(i.user, 36)}
            <div class="grow"><b>${esc(i.user.displayName)}</b><small>@${esc(i.user.username)} · waiting to accept</small></div>
            <button class="btn btn-sm btn-ghost" data-cancel-invite="${i.inviteId}">Cancel</button>
          </div>`)
        .join('')}</div>
    </div>` : ''}
    <div class="section">
      <h2 class="section-title">Members <span class="count">${ctx.members.length}</span></h2>
      <div class="card list-card">${ctx.members
        .map((m) => `
          <div class="invite-row">${avatar(m, 40)}
            <div class="grow"><a class="user-link" href="#/user/${m.id}"><b>${esc(m.displayName)}${m.id === store.me.id ? ' (you)' : ''}</b></a><span data-label-for="${m.id}"></span><small>@${esc(m.username)}</small></div>
            ${m.role === 'leader' ? '<span class="pill leader">Leader</span>' : ''}
            ${ctx.isLeader && m.role !== 'leader' ? `<button class="btn btn-sm btn-ghost" data-promote="${m.id}">Make leader</button><button class="btn btn-sm btn-danger" data-kick="${m.id}">Remove</button>` : ''}
            ${!ctx.isLeader && m.id === store.me.id ? '<button class="btn btn-sm btn-danger" data-leave>Leave group</button>' : ''}
          </div>`)
        .join('')}</div>
    </div>
    ${ctx.isLeader ? `
    <div class="section">
      <h2 class="section-title">Group settings</h2>
      <form class="card" id="set-form">
        <div class="field"><label>Name</label><input class="input" name="name" maxlength="60" required value="${esc(g.name)}"></div>
        <div class="field"><label>Description</label><textarea class="input" name="description" maxlength="300">${esc(g.description)}</textarea></div>
        <div class="field"><label>Verification window (hours after deadline)</label><input class="input" type="number" min="1" max="168" name="grace" value="${g.verifyGraceHours}"><small>Teammates must press Checked within this window, or they get exposed.</small></div>
        <div class="field"><label>Reminders for unfinished jobdesks</label>${reminderSelect('reminder', g.reminderEveryDays)}<small>Default for every mission in this group. Missions with their own setting keep it.</small></div>
        <div class="form-error"></div>
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="button" class="btn btn-danger" id="del-group">Delete group</button>
            <a class="btn" href="/api/groups/${ctx.groupId}/export.csv" download>Export missions (CSV)</a>
          </div>
          <button class="btn btn-primary">Save settings</button>
        </div>
      </form>
    </div>` : ''}`);

  let labels = [];
  const paintLabelChips = () =>
    $$('[data-label-for]', container).forEach((el) => {
      el.innerHTML = labelChips(labels.filter((l) => l.user.id === Number(el.dataset.labelFor)));
    });
  async function loadLabels() {
    ({ labels } = await api(`/groups/${ctx.groupId}/labels`));
    const box = $('#labels-section', container);
    if (!box) return;
    const votes = labels.filter((l) => l.redeem).length;
    box.innerHTML = labels.length
      ? `<div class="section">
           <h2 class="section-title">🏷️ Beban labels <span class="count">${labels.length}</span>${votes ? `<span class="pill revision">${votes} redeem vote${votes > 1 ? 's' : ''} open</span>` : ''}</h2>
           <p class="beban-intro">Members who missed a jobdesk here carry “Beban ${esc(g.name)}” on their profile. Only a redeem vote where every other member approves removes it.</p>
           <div class="beban-list">${labels.map((l) => labelCard(l, { showOwner: true })).join('')}</div>
         </div>`
      : '';
    bindLabelActions(box, loadLabels);
    paintLabelChips();
  }
  loadLabels().catch(() => {});

  api(`/groups/${ctx.groupId}/leaderboard`)
    .then(({ rows }) => {
      const lb = $('#lb', container);
      if (lb) lb.innerHTML = leaderboardHtml(rows);
      paintLabelChips();
    })
    .catch(() => {
      const lb = $('#lb', container);
      if (lb) lb.innerHTML = '<div class="empty">Could not load the leaderboard.</div>';
    });

  const inv = $('#inv-form', container);
  if (inv) {
    const input = inv.username;
    const suggest = $('#inv-suggest', container);
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return (suggest.hidden = true);
        const { users } = await api(`/users/search?q=${encodeURIComponent(q)}`);
        const memberIds = new Set(ctx.members.map((m) => m.id));
        const options = users.filter((u) => !memberIds.has(u.id));
        suggest.hidden = options.length === 0;
        suggest.innerHTML = options
          .map((u) => `<button type="button" data-u="${esc(u.username)}">${avatar(u, 28)}<span><b>${esc(u.displayName)}</b> <small>@${esc(u.username)}</small></span></button>`)
          .join('');
        $$('[data-u]', suggest).forEach((b) => (b.onclick = () => {
          input.value = b.dataset.u;
          suggest.hidden = true;
        }));
      }, 200);
    });
    input.addEventListener('blur', () => setTimeout(() => (suggest.hidden = true), 150));
    inv.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = inv.querySelector('.form-error');
      err.textContent = '';
      busy(inv.querySelector('.btn-primary'), async () => {
        try {
          await api(`/groups/${ctx.groupId}/invites`, { method: 'POST', body: { username: input.value.trim().replace(/^@/, '') } });
          toast('Invite sent', { body: `@${input.value.trim()} will see it on their home page.` });
          await ctx.reload();
          renderMembers(container, ctx);
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });
  }

  const set = $('#set-form', container);
  if (set) {
    set.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(set.querySelector('.btn-primary'), async () => {
        try {
          await api(`/groups/${ctx.groupId}`, {
            method: 'PATCH',
            body: {
              name: set.name.value,
              description: set.description.value,
              verifyGraceHours: Number(set.grace.value),
              reminderEveryDays: Number(set.reminder.value),
            },
          });
          toast('Settings saved');
          await ctx.reload();
          app.refreshGroups();
        } catch (ex) {
          set.querySelector('.form-error').textContent = ex.message;
        }
      });
    });
    $('#del-group', container).onclick = async () => {
      if (!(await confirmDialog('Delete this group?', 'All chats, missions, proofs and confessions will be gone for everyone. This cannot be undone.', { confirmText: 'Delete group', danger: true }))) return;
      await api(`/groups/${ctx.groupId}`, { method: 'DELETE' });
      await app.refreshGroups();
      location.hash = '#/home';
    };
  }

  container.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cancelInvite) {
      await api(`/groups/${ctx.groupId}/invites/${b.dataset.cancelInvite}`, { method: 'DELETE' });
      await ctx.reload();
      renderMembers(container, ctx);
    } else if (b.dataset.promote) {
      const m = ctx.members.find((x) => x.id === Number(b.dataset.promote));
      if (!(await confirmDialog(`Make ${m.displayName} the leader?`, 'They will manage missions, members and settings. You become a regular member and can then leave the group.', { confirmText: 'Make leader' }))) return;
      try {
        await api(`/groups/${ctx.groupId}/transfer`, { method: 'POST', body: { userId: m.id } });
        toast(`${m.displayName} is now the leader`);
        await ctx.reload();
        app.refreshGroups();
        renderMembers(container, ctx);
      } catch (ex) {
        toast(ex.message, { error: true });
      }
    } else if (b.dataset.kick) {
      const m = ctx.members.find((x) => x.id === Number(b.dataset.kick));
      if (!(await confirmDialog(`Remove ${m.displayName}?`, 'Their unfinished missions in this group will be deleted.', { confirmText: 'Remove', danger: true }))) return;
      await api(`/groups/${ctx.groupId}/members/${m.id}`, { method: 'DELETE' });
      await ctx.reload();
      renderMembers(container, ctx);
    } else if (b.dataset.leave !== undefined) {
      if (!(await confirmDialog('Leave this group?', 'Your unfinished missions here will be deleted.', { confirmText: 'Leave', danger: true }))) return;
      await api(`/groups/${ctx.groupId}/members/${store.me.id}`, { method: 'DELETE' });
      await app.refreshGroups();
      location.hash = '#/home';
    }
  };
}
