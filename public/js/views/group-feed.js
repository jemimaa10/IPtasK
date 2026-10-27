import { api, bus } from '../api.js';
import { store } from '../state.js';
import { $, $$, esc, avatar, timeAgo, fmtDate, fmtSize, countdown, statusPill, openModal, toast, busy } from '../ui.js';
import { confessionTweetHtml, downloadConfession } from './confession.js';

/** Upload modal: pick one of my open missions, attach files, add a caption. */
export function openUploadModal(ctx, missions, preselectId, onDone) {
  const files = [];
  const { modal, close } = openModal(`
    <h2>Upload proof of work</h2>
    <p class="sub">Screenshots or files that prove the job is done. Every teammate will review it.</p>
    <form id="up-form">
      <div class="field">
        <label>Mission</label>
        <select class="input" name="mission">${missions
          .map((m) => `<option value="${m.id}" ${m.id === preselectId ? 'selected' : ''}>${esc(m.title)} — ${countdown(m.deadline).text}</option>`)
          .join('')}</select>
      </div>
      <div class="field">
        <label>Caption <small>(optional)</small></label>
        <textarea class="input" name="caption" maxlength="1000" placeholder="What did you finish? Anything reviewers should know?"></textarea>
      </div>
      <div class="dropzone" id="up-drop">📎 Drop files here or <b style="color:var(--lime)">browse</b><br><small>Images, PDF, docs, zip… up to 6 files, 15 MB each</small></div>
      <input type="file" id="up-input" multiple hidden>
      <div class="picked" id="up-picked"></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Post proof</button></div>
    </form>`);
  const form = $('#up-form', modal);
  const input = $('#up-input', modal);
  const drop = $('#up-drop', modal);
  form.querySelector('[data-close]').onclick = close;

  function renderPicked() {
    const box = $('#up-picked', modal);
    box.innerHTML = files
      .map((f, i) => `<div class="thumb">${f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : esc(f.name.slice(0, 24))}<button type="button" data-rm="${i}">✕</button></div>`)
      .join('');
    $$('[data-rm]', box).forEach((b) => (b.onclick = () => {
      files.splice(Number(b.dataset.rm), 1);
      renderPicked();
    }));
  }
  const add = (list) => {
    for (const f of list) if (files.length < 6) files.push(f);
    renderPicked();
  };
  drop.onclick = () => input.click();
  input.onchange = () => {
    add(input.files);
    input.value = '';
  };
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    add(e.dataTransfer.files);
  });
  modal.addEventListener('paste', (e) => add([...e.clipboardData.files]));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    if (files.length === 0) {
      err.textContent = 'Attach at least one screenshot or file.';
      return;
    }
    busy(form.querySelector('[type=submit]'), async () => {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      fd.append('caption', form.caption.value);
      try {
        await api(`/missions/${form.mission.value}/proofs`, { method: 'POST', form: fd });
        close();
        toast('Proof posted', { body: 'Your teammates have been notified to review it.' });
        onDone?.();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });
}

function fileExt(name) {
  return (name.split('.').pop() || 'file').slice(0, 4);
}

function proofTweetHtml(p) {
  const images = p.files.filter((f) => f.isImage);
  const others = p.files.filter((f) => !f.isImage);
  const allChecked = p.reviewers.length > 0 && p.reviewers.every((r) => r.state === 'checked');
  const checkedBy = p.reviewers.filter((r) => r.state === 'checked');
  const checkedTag = checkedBy.length
    ? `<span class="checked-tag">✓ Checked${allChecked ? ' by all' : ` ${checkedBy.length}/${p.reviewers.length}`}</span>`
    : '';
  const notes = p.reviewers.flatMap((r) => r.revisions.map((rev) => ({ ...rev, user: r.user })));
  const end = countdown(p.mission.graceEnd);

  return `
    <article class="tweet" data-proof="${p.id}">
      ${avatar(p.author, 44)}
      <div class="tweet-body">
        <div class="tweet-head">
          <b>${esc(p.author.displayName)}</b><span class="handle">@${esc(p.author.username)}</span>
          <span class="dot">·</span><time title="${fmtDate(p.createdAt)}">${timeAgo(p.createdAt)}</time>
        </div>
        <div class="tweet-mission">
          <span>Proof for <strong>${esc(p.mission.title)}</strong></span>
          ${p.isLatest ? statusPill(p.mission.status) : ''}
        </div>
        ${p.caption ? `<p class="tweet-caption">${esc(p.caption)}</p>` : ''}
        ${images.length
          ? `<div class="tweet-media n${Math.min(images.length, 4)}">${images
              .slice(0, 4)
              .map((f) => `<a href="${f.url}" target="_blank" rel="noopener"><img src="${f.url}" alt="${esc(f.name)}" loading="lazy"></a>`)
              .join('')}</div>`
          : ''}
        <div class="files">
          ${images.length ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-3)"><span>${images.length} screenshot${images.length > 1 ? 's' : ''}</span>${checkedTag}</div>` : ''}
          ${others
            .map((f) => `
              <a class="file-chip" href="${f.url}" target="_blank" rel="noopener">
                <span class="ext">${esc(fileExt(f.name))}</span>
                <span class="fname">${esc(f.name)}<br><small>${fmtSize(f.size)}</small></span>
                ${checkedTag}
              </a>`)
            .join('')}
        </div>
        ${p.aiNote ? `<div class="ai-note"><b>✨ AI hint:</b> ${esc(p.aiNote)}</div>` : ''}
        ${p.reviewers.length
          ? `<div class="verify-list">${p.reviewers
              .map((r) => `<span class="verify-chip ${r.state}" title="${r.state === 'checked' ? 'Checked' : r.state === 'revision' ? 'Asked for revision' : 'Has not reviewed yet'}">${avatar(r.user, 20)}${esc(r.user.displayName)} ${r.state === 'checked' ? '✓' : r.state === 'revision' ? '✎' : '…'}</span>`)
              .join('')}</div>`
          : '<div class="superseded">Nobody else in the group yet — auto-verified.</div>'}
        ${notes.length
          ? `<div class="revision-notes">${notes
              .map((n) => `<div class="revision-note"><b>${esc(n.user.displayName)}</b> gave revision · ${timeAgo(n.at)}<br>${esc(n.message)}</div>`)
              .join('')}</div>`
          : ''}
        ${!p.isLatest ? '<div class="superseded">A newer proof replaced this one.</div>' : ''}
        ${p.canReview
          ? `<div class="tweet-actions">
               <button class="btn btn-sm btn-revision" data-revision="${p.id}">✎ Revision</button>
               <button class="btn btn-sm btn-checked" data-check="${p.id}">✓ Checked</button>
               <span style="margin-left:auto;font-size:12px;align-self:center" class="countdown ${end.cls}">review within ${end.text.replace(' left', '')}</span>
             </div>
             <div class="revision-box" data-box="${p.id}" hidden>
               <textarea class="input" maxlength="1000" placeholder="What should ${esc(p.author.displayName)} fix?"></textarea>
               <div class="row-end"><button class="btn btn-sm btn-ghost" data-cancel="${p.id}">Cancel</button><button class="btn btn-sm btn-violet" data-send="${p.id}">Send revision</button></div>
             </div>`
          : p.myState === 'checked' && p.isLatest
            ? '<div class="tweet-actions"><span class="checked-tag">✓ You checked this</span></div>'
            : ''}
      </div>
    </article>`;
}

export function renderFeed(container, ctx) {
  container.innerHTML = `
    <div id="feed-composer"></div>
    <div id="feed-list"><div class="loading"><span class="spinner"></span></div></div>
    <div style="text-align:center;margin-top:16px"><button class="btn btn-sm" id="feed-more" hidden>Load older</button></div>`;
  let items = [];
  let nextBefore = null;
  let myMissions = [];
  let refreshQueued = false;

  async function loadComposer() {
    const { missions } = await api(`/groups/${ctx.groupId}/missions`);
    myMissions = missions.filter(
      (m) => m.assignee.id === store.me.id && ['open', 'revision', 'submitted'].includes(m.status) && m.deadline > Date.now()
    );
    const box = $('#feed-composer', container);
    if (!box) return;
    box.innerHTML = myMissions.length
      ? `<div class="proof-composer">${avatar(store.me, 44)}<button class="prompt" id="open-upload">Finished a jobdesk? Upload your proof…</button><button class="btn btn-primary" id="open-upload-2">Post proof</button></div>`
      : '';
    $$('#open-upload, #open-upload-2', box).forEach((b) => (b.onclick = () => openUploadModal(ctx, myMissions, null, refresh)));
  }

  function draw() {
    const list = $('#feed-list', container);
    if (!list) return;
    if (items.length === 0) {
      list.innerHTML = '<div class="empty"><b>No proof posted yet</b>When someone uploads proof of their jobdesk, it appears here for everyone to check.</div>';
    } else {
      list.innerHTML = `<div class="feed">${items.map((it) => (it.type === 'proof' ? proofTweetHtml(it) : confessionTweetHtml(it))).join('')}</div>`;
    }
    $('#feed-more', container).hidden = !nextBefore;
  }

  async function refresh() {
    const data = await api(`/groups/${ctx.groupId}/feed`);
    items = data.items;
    nextBefore = data.nextBefore;
    draw();
    loadComposer();
  }

  // Don't wipe a half-written revision when the feed updates in the background.
  function safeRefresh() {
    const typing = $$('.revision-box:not([hidden]) textarea', container).some((t) => t.value.trim());
    if (typing) refreshQueued = true;
    else refresh();
  }

  container.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.check) {
      busy(t, async () => {
        try {
          await api(`/proofs/${t.dataset.check}/review`, { method: 'POST', body: { type: 'checked' } });
          toast('Marked as checked ✓');
          await refresh();
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    } else if (t.dataset.revision) {
      const box = container.querySelector(`[data-box="${t.dataset.revision}"]`);
      box.hidden = !box.hidden;
      if (!box.hidden) box.querySelector('textarea').focus();
    } else if (t.dataset.cancel) {
      const box = container.querySelector(`[data-box="${t.dataset.cancel}"]`);
      box.hidden = true;
      box.querySelector('textarea').value = '';
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      }
    } else if (t.dataset.send) {
      const box = container.querySelector(`[data-box="${t.dataset.send}"]`);
      const message = box.querySelector('textarea').value.trim();
      if (!message) return toast('Write what needs to be revised.', { error: true });
      busy(t, async () => {
        try {
          await api(`/proofs/${t.dataset.send}/review`, { method: 'POST', body: { type: 'revision', message } });
          refreshQueued = false;
          toast('Revision sent', { body: 'They got a notification with your note.' });
          await refresh();
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    } else if (t.dataset.download) {
      const c = items.find((it) => it.type === 'confession' && it.id === Number(t.dataset.download));
      if (c) downloadConfession(c, ctx.group.name);
    } else if (t.id === 'feed-more') {
      busy(t, async () => {
        const data = await api(`/groups/${ctx.groupId}/feed?before=${nextBefore}`);
        items = [...items, ...data.items];
        nextBefore = data.nextBefore;
        draw();
      });
    }
  });

  refresh().catch((err) => toast(err.message, { error: true }));
  const offs = [bus.on('feed:changed', safeRefresh), bus.on('missions:changed', loadComposer)];
  return () => offs.forEach((off) => off());
}
