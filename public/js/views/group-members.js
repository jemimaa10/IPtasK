import { api } from '../api.js';
import { store, app } from '../state.js';
import { $, $$, esc, avatar, confirmDialog, toast, busy } from '../ui.js';

export function renderMembers(container, ctx) {
  const g = ctx.group;
  container.innerHTML = `
    ${ctx.isLeader ? `
    <div class="section" style="margin-top:0">
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
    <div class="section" ${ctx.isLeader ? '' : 'style="margin-top:0"'}>
      <h2 class="section-title">Members <span class="count">${ctx.members.length}</span></h2>
      <div class="card list-card">${ctx.members
        .map((m) => `
          <div class="invite-row">${avatar(m, 40)}
            <div class="grow"><b>${esc(m.displayName)}${m.id === store.me.id ? ' (you)' : ''}</b><small>@${esc(m.username)}</small></div>
            ${m.role === 'leader' ? '<span class="pill leader">Leader</span>' : ''}
            ${ctx.isLeader && m.role !== 'leader' ? `<button class="btn btn-sm btn-danger" data-kick="${m.id}">Remove</button>` : ''}
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
        <div class="form-error"></div>
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn btn-danger" id="del-group">Delete group</button>
          <button class="btn btn-primary">Save settings</button>
        </div>
      </form>
    </div>` : ''}`;

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
            body: { name: set.name.value, description: set.description.value, verifyGraceHours: Number(set.grace.value) },
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
