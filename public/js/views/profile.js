import { api } from '../api.js';
import { store, app } from '../state.js';
import { $, esc, avatar, toast, busy, openModal, confirmDialog, takeAuthError, googleButton } from '../ui.js';
import { cropAvatar } from '../cropper.js';
import { labelCard, bindLabelActions } from './labels.js';

export function statsHtml(st, { own = true } = {}) {
  if (!st) return '<div class="loading"><span class="spinner"></span></div>';
  const who = own ? 'you' : 'they';
  const tile = (value, label, hint, tone = '') =>
    `<div class="stat ${tone}" title="${hint}"><b>${value}</b><span>${label}</span></div>`;
  const fact = (value, label, hint, tone = '') =>
    `<span class="stat-fact ${value ? tone : ''}" title="${hint}"><b>${value}</b> ${label}</span>`;
  return `
    <div class="stat-grid">
      ${tile(`🔥 ${st.streak.current}`, `day streak · best ${st.streak.best}`, `Days in a row ${who} uploaded at least one proof. Today doesn't break it until it's over.`, 'lime')}
      ${tile(st.completionRate == null ? '—' : `${st.completionRate}%`, 'on time', 'Share of finished jobdesks that got verified before the deadline.')}
      ${tile(st.verified, 'jobdesks done', `${own ? 'Your' : 'Their'} jobdesks that every teammate checked.`, 'green')}
    </div>
    <div class="stat-facts">
      ${fact(st.open, 'open', 'Jobdesks still in progress.')}
      ${fact(st.failed + st.unverified, 'failed', 'Missed the deadline or never got verified.', 'red')}
      ${fact(st.proofs ?? 0, 'proofs', 'Proofs uploaded.')}
      ${fact(st.checkedForOthers ?? 0, 'checked for teammates', `Teammates' proofs ${who} approved.`)}
      ${fact(st.revisionsAsked ?? 0, 'revisions asked', `Teammates' proofs ${who} sent back for revision.`)}
      ${fact(st.confessions, 'confessions', 'Times exposed on the confession wall.', 'red')}
    </div>`;
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
  let hasPassword = true;
  let google = null;
  let googleEnabled = false;
  const redirectError = takeAuthError();
  if (redirectError) toast(redirectError, { error: true });
  Promise.all([api('/me/stats'), api('/auth/me'), api('/auth/providers').catch(() => ({}))])
    .then(([st, me, providers]) => {
      stats = st;
      hasRecoveryCode = me.hasRecoveryCode;
      hasPassword = me.hasPassword;
      google = me.google;
      googleEnabled = Boolean(providers.google);
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
        ${google || googleEnabled ? `
        <div class="section">
          <h2 class="section-title">Google account ${google ? '<span class="pill verified">Connected</span>' : ''}</h2>
          <div class="card google-card">
            ${google
              ? `<p>You can log in with Google${google.email ? ` (<b>${esc(google.email)}</b>)` : ''}.</p>
                 ${hasPassword ? '<button class="btn btn-ghost" id="g-unlink">Disconnect Google</button>' : '<small class="stat-note">Set a password below before you can disconnect Google.</small>'}`
              : `<p>Connect Google to log in with one tap, without typing your password.</p>
                 ${googleButton('Connect Google', '/api/auth/google?mode=link')}`}
          </div>
        </div>` : ''}
        <div class="section">
          <h2 class="section-title">${hasPassword ? 'Change password' : 'Set a password'}</h2>
          <form class="card" id="pw-form">
            ${hasPassword
              ? '<div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password" required></div>'
              : `<p style="margin:0 0 12px;color:var(--text-2)">You log in with Google. Add a password to also log in with <b>@${esc(store.me.username)}</b>.</p>`}
            <div class="field"><label>New password</label><input class="input" type="password" name="next" autocomplete="new-password" minlength="6" required></div>
            <div class="form-error"></div>
            <button class="btn">${hasPassword ? 'Update password' : 'Set password'}</button>
            <small class="stat-note">Changing it logs you out on your other devices.</small>
          </form>
        </div>
        ${hasPassword ? `<div class="section">
          <h2 class="section-title">Recovery code ${hasRecoveryCode === false ? '<span class="pill failed">Not set</span>' : hasRecoveryCode ? '<span class="pill verified">Saved</span>' : ''}</h2>
          <form class="card" id="rc-form">
            <p style="margin:0 0 12px;color:var(--text-2)">IPtasK has no email, so this code is the only way back in if you forget your password. Making a new one replaces the old one.</p>
            <div class="field"><label>Confirm with your password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
            <div class="form-error"></div>
            <button class="btn">${hasRecoveryCode ? 'Make a new recovery code' : 'Create recovery code'}</button>
          </form>
        </div>` : ''}
      </div>`;

    $('#p-logout', view).onclick = () => app.logout();
    loadLabels();
    const file = $('#p-file', view);
    $('#p-upload', view).onclick = () => file.click();
    file.onchange = async () => {
      const picked = file.files[0];
      file.value = ''; // so choosing the same file again still opens the editor
      if (!picked) return;
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(picked.type)) return toast('Choose a PNG, JPG, WEBP or GIF image.', { error: true });
      if (picked.size > 25 * 1024 * 1024) return toast('That image is too large (max 25 MB).', { error: true });
      let cropped;
      try {
        cropped = await cropAvatar(picked, { name: store.me.displayName });
      } catch (err) {
        return toast(err.message, { error: true });
      }
      if (!cropped) return; // cancelled: the current photo stays
      const fd = new FormData();
      fd.append('avatar', cropped, 'avatar.jpg');
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
        if (!(await confirmDialog('Remove your photo?', 'Your initials will be shown instead.', { confirmText: 'Remove photo', danger: true }))) return;
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
          await api('/me/password', { method: 'PATCH', body: { current: pw.current?.value || '', next: pw.next.value } });
          pw.reset();
          toast(hasPassword ? 'Password updated' : 'Password set');
          if (!hasPassword) {
            hasPassword = true;
            draw();
          }
        } catch (err) {
          pw.querySelector('.form-error').textContent = err.message;
        }
      });
    });

    const unlink = $('#g-unlink', view);
    if (unlink) {
      unlink.onclick = () => busy(unlink, async () => {
        try {
          await api('/me/google/unlink', { method: 'POST' });
          google = null;
          draw();
          toast('Google disconnected');
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    }

    const rc = $('#rc-form', view);
    rc?.addEventListener('submit', (e) => {
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
