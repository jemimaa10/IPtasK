import { api } from '../api.js';
import { store, app } from '../state.js';
import { $, esc, avatar, toast, busy, openModal } from '../ui.js';
import { labelCard, bindLabelActions } from './labels.js';

export function statsHtml(st, { own = true } = {}) {
  if (!st) return '<div class="loading"><span class="spinner"></span></div>';
  const tile = (value, label, tone = '') => `<div class="stat ${tone}"><b>${value}</b><span>${label}</span></div>`;
  return `
    <div class="stat-grid">
      ${tile(`🔥 ${st.streak.current}`, `day streak · best ${st.streak.best}`, 'lime')}
      ${tile(st.completionRate == null ? '—' : `${st.completionRate}%`, 'finished on time')}
      ${tile(st.verified, 'verified', 'green')}
      ${tile(st.failed + st.unverified, 'failed / unverified', 'red')}
      ${tile(st.open, 'still open')}
      ${tile(st.confessions, 'confessions')}
    </div>
    <small class="stat-note">Streak = days in a row ${own ? 'you' : 'they'} uploaded at least one proof. Today doesn't break it until it's over.</small>`;
}

export function renderProfile(view) {
  async function loadLabels() {
    const box = $('#p-labels', view);
    if (!box) return;
    const { labels } = await api(`/users/${store.me.id}`);
    if (!box.isConnected) return;
    box.innerHTML = labels.length
      ? `<div class="section" style="margin-top:0">
           <h2 class="section-title">Your labels <span class="count">${labels.length}</span></h2>
           <p class="beban-intro">Everyone can see these on your profile. To remove one, ask the group for a redeem vote — every other member has to approve.</p>
           <div class="beban-list">${labels.map((l) => labelCard(l)).join('')}</div>
         </div><div style="height:32px"></div>`
      : '';
    bindLabelActions(box, loadLabels);
  }

  let stats = null;
  let hasRecoveryCode = null;
  Promise.all([api('/me/stats'), api('/auth/me')])
    .then(([st, me]) => {
      stats = st;
      hasRecoveryCode = me.hasRecoveryCode;
      if (view.isConnected) draw();
    })
    .catch((err) => toast(err.message, { error: true }));

  function draw() {
    view.innerHTML = `
      <div class="page" style="max-width:640px">
        <div class="page-head"><div><h1>Profile</h1><p>This is how you appear in chats, the proof feed — and on confession posts.</p></div>
          <div style="display:flex;gap:8px"><a class="btn btn-ghost" href="#/user/${store.me.id}">View public profile</a><button class="btn btn-ghost" id="p-logout">Log out</button></div></div>
        <div id="p-labels"></div>
        <div class="section" style="margin-top:0">
          <h2 class="section-title">Your track record</h2>
          ${statsHtml(stats)}
        </div>
        <div class="section">
        <h2 class="section-title">Account</h2>
        <div class="card">
          <div class="profile-avatar">
            ${avatar(store.me, 88)}
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" id="p-upload">Upload photo</button>
              ${store.me.avatarUrl ? '<button class="btn btn-ghost" id="p-remove">Use default</button>' : ''}
              <input type="file" id="p-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
            </div>
          </div>
          <form id="p-form">
            <div class="field"><label>Display name</label><input class="input" name="displayName" maxlength="40" required value="${esc(store.me.displayName)}"></div>
            <div class="field"><label>Username</label><input class="input" value="@${esc(store.me.username)}" disabled><small>Your leader invites you with this. It can't be changed.</small></div>
            <div class="form-error"></div>
            <button class="btn btn-primary">Save profile</button>
          </form>
        </div>
        </div>
        <div class="section">
          <h2 class="section-title">Change password</h2>
          <form class="card" id="pw-form">
            <div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password" required></div>
            <div class="field"><label>New password</label><input class="input" type="password" name="next" autocomplete="new-password" minlength="6" required></div>
            <div class="form-error"></div>
            <button class="btn">Update password</button>
            <small class="stat-note">Changing it logs you out on your other devices.</small>
          </form>
        </div>
        <div class="section">
          <h2 class="section-title">Recovery code ${hasRecoveryCode === false ? '<span class="pill failed">Not set</span>' : hasRecoveryCode ? '<span class="pill verified">Saved</span>' : ''}</h2>
          <form class="card" id="rc-form">
            <p style="margin:0 0 12px;color:var(--text-2)">IPtasK has no email, so this code is the only way back in if you forget your password. Making a new one replaces the old one.</p>
            <div class="field"><label>Confirm with your password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
            <div class="form-error"></div>
            <button class="btn">${hasRecoveryCode ? 'Make a new recovery code' : 'Create recovery code'}</button>
          </form>
        </div>
      </div>`;

    $('#p-logout', view).onclick = () => app.logout();
    loadLabels();
    const file = $('#p-file', view);
    $('#p-upload', view).onclick = () => file.click();
    file.onchange = () => {
      if (!file.files[0]) return;
      const fd = new FormData();
      fd.append('avatar', file.files[0]);
      busy($('#p-upload', view), async () => {
        try {
          store.me = (await api('/me/avatar', { method: 'POST', form: fd })).user;
          app.renderSidebar();
          draw();
          toast('Photo updated');
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    };
    const remove = $('#p-remove', view);
    if (remove) {
      remove.onclick = async () => {
        store.me = (await api('/me/avatar', { method: 'DELETE' })).user;
        app.renderSidebar();
        draw();
      };
    }

    const form = $('#p-form', view);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), async () => {
        try {
          store.me = (await api('/me', { method: 'PATCH', body: { displayName: form.displayName.value } })).user;
          app.renderSidebar();
          toast('Profile saved');
        } catch (err) {
          form.querySelector('.form-error').textContent = err.message;
        }
      });
    });

    const pw = $('#pw-form', view);
    pw.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(pw.querySelector('button'), async () => {
        try {
          await api('/me/password', { method: 'PATCH', body: { current: pw.current.value, next: pw.next.value } });
          pw.reset();
          toast('Password updated');
        } catch (err) {
          pw.querySelector('.form-error').textContent = err.message;
        }
      });
    });

    const rc = $('#rc-form', view);
    rc.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(rc.querySelector('button'), async () => {
        try {
          const { code } = await api('/me/recovery-code', { method: 'POST', body: { password: rc.password.value } });
          hasRecoveryCode = true;
          draw();
          showRecoveryCode(code);
        } catch (err) {
          rc.querySelector('.form-error').textContent = err.message;
        }
      });
    });
  }
  draw();
}

function showRecoveryCode(code) {
  const { modal } = openModal(`
    <h2>Save your recovery code</h2>
    <p style="color:var(--text-2)">Write it down or keep it in a password manager. It is shown only once, and works once.</p>
    <div class="recovery-code">${esc(code)}</div>
    <div class="modal-actions">
      <button class="btn" data-copy>Copy</button>
      <button class="btn btn-primary" data-close>I saved it</button>
    </div>`);
  modal.querySelector('[data-copy]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied');
    } catch {
      toast('Copy failed — select the code and copy it by hand.', { error: true });
    }
  };
}
