import { api } from '../api.js';
import { store, app } from '../state.js';
import { $, esc, avatar, toast, busy } from '../ui.js';

export function renderProfile(view) {
  function draw() {
    view.innerHTML = `
      <div class="page" style="max-width:640px">
        <div class="page-head"><div><h1>Profile</h1><p>This is how you appear in chats, the proof feed — and on confession posts.</p></div></div>
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
        <div class="section">
          <h2 class="section-title">Change password</h2>
          <form class="card" id="pw-form">
            <div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password" required></div>
            <div class="field"><label>New password</label><input class="input" type="password" name="next" autocomplete="new-password" minlength="6" required></div>
            <div class="form-error"></div>
            <button class="btn">Update password</button>
          </form>
        </div>
      </div>`;

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
  }
  draw();
}
