// "Beban <group>" labels and redeem votes: shared by the profile pages and the group Members tab.
import { api } from '../api.js';
import { store } from '../state.js';
import { $$, esc, avatar, timeAgo, fmtDate, openModal, toast, busy } from '../ui.js';

export function labelChip(label) {
  const times = label.failCount > 1 ? ` ×${label.failCount}` : '';
  return `<span class="beban-chip" title="Missed: ${esc(label.reason)}">🏷️ ${esc(label.text)}${times}</span>`;
}

/** Small chips next to a user's name, for every active label they carry. */
export function labelChips(labels) {
  return labels.length ? `<span class="beban-chips">${labels.map(labelChip).join('')}</span>` : '';
}

function voteBox(label) {
  const r = label.redeem;
  const pct = r.required ? Math.round((r.approvals / r.required) * 100) : 100;
  const isOwner = label.user.id === store.me.id;
  return `
    <div class="redeem-box">
      <div class="redeem-head">
        <b>🗳️ Redeem vote</b>
        <span>${r.approvals}/${r.required} approved · started ${timeAgo(r.createdAt)}</span>
      </div>
      ${r.message ? `<p class="redeem-msg">“${esc(r.message)}”</p>` : ''}
      <div class="progress redeem-progress"><i style="width:${pct}%"></i></div>
      <div class="verify-list">${r.voters
        .map((v) => {
          const state = v.vote === true || v.vote === 1 ? 'checked' : v.vote === false || v.vote === 0 ? 'revision' : 'pending';
          const mark = state === 'checked' ? '✓' : state === 'revision' ? '✗' : '…';
          return `<span class="verify-chip ${state}">${avatar(v.user, 20)}${esc(v.user.displayName)} ${mark}</span>`;
        })
        .join('')}</div>
      ${r.canVote
        ? `<div class="tweet-actions">
             <button class="btn btn-sm btn-danger" data-vote="${r.id}" data-approve="0">✗ Keep the label</button>
             <button class="btn btn-sm btn-checked" data-vote="${r.id}" data-approve="1">✓ Approve redeem</button>
             ${r.myVote !== null ? `<span class="redeem-mine">You voted: ${r.myVote ? 'approve' : 'keep'} (you can change it)</span>` : ''}
           </div>`
        : isOwner
          ? '<p class="redeem-note">Waiting for your teammates. Every one of them has to approve.</p>'
          : ''}
    </div>`;
}

/**
 * Full label card. `showGroup` adds a link to the group; the owner gets the "Ask for redeem" button,
 * group members get the vote buttons.
 */
export function labelCard(label, { showOwner = false } = {}) {
  const isOwner = label.user.id === store.me.id;
  const waitUntil = label.retryAt && label.retryAt > Date.now() ? label.retryAt : null;
  return `
    <div class="beban-card">
      <div class="beban-top">
        ${showOwner ? avatar(label.user, 36) : ''}
        <div class="grow">
          ${showOwner ? `<a class="user-link" href="#/user/${label.user.id}"><b>${esc(label.user.displayName)}</b></a> ` : ''}
          ${labelChip(label)}
          <small>Missed “${esc(label.reason)}”${label.failCount > 1 ? ` and ${label.failCount - 1} more` : ''} · since ${fmtDate(label.createdAt)}</small>
        </div>
      </div>
      ${label.redeem
        ? voteBox(label)
        : isOwner
          ? `<div class="tweet-actions">
               <button class="btn btn-sm btn-primary" data-redeem-ask="${label.id}" ${waitUntil ? 'disabled' : ''}>🗳️ Ask for redeem</button>
               ${waitUntil ? `<span class="redeem-note">Last vote was rejected. Try again after ${fmtDate(waitUntil)}.</span>` : '<span class="redeem-note">Every other member of the group has to approve.</span>'}
             </div>`
          : '<p class="redeem-note">No redeem vote yet. Only the label owner can ask for one.</p>'}
    </div>`;
}

/** Wire the redeem/vote buttons inside `root`; `onChange` reloads whatever shows the labels. */
export function bindLabelActions(root, onChange) {
  $$('[data-vote]', root).forEach((b) => (b.onclick = () => busy(b, async () => {
    try {
      const { status } = await api(`/redeem/${b.dataset.vote}/vote`, { method: 'POST', body: { approve: b.dataset.approve === '1' } });
      toast(status === 'approved' ? 'Redeemed — the label is gone 🎉' : status === 'rejected' ? 'Vote closed: the label stays' : 'Vote saved');
      onChange();
    } catch (err) {
      toast(err.message, { error: true });
    }
  })));

  $$('[data-redeem-ask]', root).forEach((b) => (b.onclick = () => {
    const { modal, close } = openModal(`
      <h2>Ask for redeem</h2>
      <p class="sub">Every other member of the group gets a vote. If all of them approve, the label disappears from your profile. One “keep” closes the vote, and you can ask again after 24 hours.</p>
      <form>
        <div class="field"><label>Message to your group <small>(optional)</small></label>
          <textarea class="input" name="message" maxlength="300" placeholder="e.g. Maaf, minggu lalu aku sakit. Bab 3 sudah aku selesaikan dan upload."></textarea></div>
        <div class="form-error"></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Start the vote</button></div>
      </form>`);
    const form = modal.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('[type=submit]'), async () => {
        try {
          const { status } = await api(`/labels/${b.dataset.redeemAsk}/redeem`, { method: 'POST', body: { message: form.message.value } });
          close();
          toast(status === 'approved' ? 'Redeemed — nobody else had to vote' : 'Vote started', { body: status === 'approved' ? '' : 'Your teammates have been notified.' });
          onChange();
        } catch (err) {
          form.querySelector('.form-error').textContent = err.message;
        }
      });
    });
  }));
}
