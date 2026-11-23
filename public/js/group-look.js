// Group photo: picking, cropping and uploading. Used when creating a group and from the
// group header (the leader taps the photo).
import { api } from './api.js';
import { openModal, confirmDialog, toast } from './ui.js';
import { cropAvatar } from './cropper.js';

const TYPES = /^image\/(png|jpe?g|webp|gif)$/;

/** Opens the file chooser; resolves with the chosen image file (never resolves if cancelled). */
function chooseImage() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    input.onchange = () => input.files[0] && resolve(input.files[0]);
    input.click();
  });
}

/** Lets the user pick and crop a photo. Resolves with a square JPEG Blob, or null (a toast explains why). */
export async function pickGroupPhoto(groupName = '') {
  const file = await chooseImage();
  if (!TYPES.test(file.type)) return toast('Choose a PNG, JPG, WEBP or GIF image.', { error: true }), null;
  if (file.size > 25 * 1024 * 1024) return toast('That image is too large (max 25 MB).', { error: true }), null;
  try {
    return (await cropAvatar(file, { name: groupName || 'Your group', group: true })) || null;
  } catch (err) {
    return toast(err.message, { error: true }), null;
  }
}

export async function uploadGroupPhoto(groupId, blob) {
  const fd = new FormData();
  fd.append('avatar', blob, 'group.jpg');
  return api(`/groups/${groupId}/avatar`, { method: 'POST', form: fd });
}

/** Leader, from the group header: add, change or remove the photo. Resolves true when something changed. */
export async function editGroupPhoto(group) {
  if (group.avatarUrl) {
    const choice = await new Promise((resolve) => {
      const { modal, close } = openModal(`
        <h2>Group photo</h2>
        <p class="sub">Shown next to the group name everywhere.</p>
        <div class="sheet-list" style="gap:8px">
          <button class="btn btn-block" data-c="change">Change photo</button>
          <button class="btn btn-block btn-danger" data-c="remove">Remove photo</button>
          <button class="btn btn-block btn-ghost" data-c="">Cancel</button>
        </div>`, { className: 'sheet' });
      modal.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { close(); resolve(b.dataset.c); }));
    });
    if (!choice) return false;
    if (choice === 'remove') {
      if (!(await confirmDialog('Remove the group photo?', 'The first letter of the group name is shown instead.', { confirmText: 'Remove', danger: true }))) return false;
      try {
        await api(`/groups/${group.id}/avatar`, { method: 'DELETE' });
        toast('Group photo removed');
        return true;
      } catch (err) {
        return toast(err.message, { error: true }), false;
      }
    }
  }
  const blob = await pickGroupPhoto(group.name);
  if (!blob) return false;
  try {
    await uploadGroupPhoto(group.id, blob);
    toast('Group photo updated');
    return true;
  } catch (err) {
    return toast(err.message, { error: true }), false;
  }
}
