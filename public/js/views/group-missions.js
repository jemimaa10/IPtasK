import { api, bus } from '../api.js';
import { store } from '../state.js';
import { $, $$, esc, avatar, countdown, fmtDate, toLocalInput, statusPill, openModal, confirmDialog, toast, busy } from '../ui.js';
import { openUploadModal } from './group-feed.js';

const ACTIVE = ['open', 'submitted', 'revision'];

function memberOptions(members, selectedId) {
  return members
    .map((m) => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.displayName)} (@${esc(m.username)})${m.role === 'leader' ? ' — leader' : ''}</option>`)
    .join('');
}

function openMissionModal(ctx, mission, onDone) {
  const editing = Boolean(mission);
  const defaultDeadline = new Date();
  defaultDeadline.setDate(defaultDeadline.getDate() + 3);
  defaultDeadline.setHours(21, 0, 0, 0);
  const { modal, close } = openModal(`
    <h2>${editing ? 'Edit mission' : 'New mission'}</h2>
    <p class="sub">${editing ? 'Members get notified if the deadline or assignee changes.' : 'Assign a jobdesk to a member (you can assign yourself too — keep it fair).'}</p>
    <form>
      <div class="field"><label>Assign to</label><select class="input" name="assignee" ${editing && mission.proofCount ? 'disabled' : ''}>${memberOptions(ctx.members, mission?.assignee.id ?? store.me.id)}</select></div>
      <div class="field"><label>Jobdesk title</label><input class="input" name="title" maxlength="120" required value="${esc(mission?.title ?? '')}" placeholder="e.g. Write chapter 2 — literature review"></div>
      <div class="field"><label>Details <small>(what counts as done?)</small></label><textarea class="input" name="description" maxlength="1000" placeholder="Describe the expected result and the proof you want to see.">${esc(mission?.description ?? '')}</textarea></div>
      <div class="row">
        <div class="field"><label>Deadline</label><input class="input" type="datetime-local" name="deadline" required value="${toLocalInput(mission?.deadline ?? defaultDeadline.getTime())}"></div>
        ${editing ? '' : `
        <div class="field">
          <label>Repeat</label>
          <select class="input" name="repeat">
            <option value="none">Once</option>
            <option value="daily">Every day (habit)</option>
            <option value="weekly">Every week</option>
          </select>
        </div>`}
      </div>
      ${editing ? '' : `
      <div class="field" id="occ-field" hidden>
        <label>How many times?</label>
        <input class="input" type="number" name="occurrences" min="2" max="60" value="7">
        <small>Creates one mission per day/week, each with its own deadline, proof and checks.</small>
      </div>`}
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Assign mission'}</button></div>
    </form>`);
  const form = modal.querySelector('form');
  form.querySelector('[data-close]').onclick = close;
  if (form.repeat) form.repeat.onchange = () => ($('#occ-field', modal).hidden = form.repeat.value === 'none');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {
      assigneeId: Number(form.assignee.value),
      title: form.title.value,
      description: form.description.value,
      deadline: new Date(form.deadline.value).getTime(),
    };
    if (!editing) {
      body.repeat = form.repeat.value;
      body.occurrences = Number(form.occurrences.value);
    }
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        if (editing) await api(`/missions/${mission.id}`, { method: 'PATCH', body });
        else {
          const res = await api(`/groups/${ctx.groupId}/missions`, { method: 'POST', body });
          toast(res.created > 1 ? `${res.created} missions created` : 'Mission assigned', { body: 'The member has been notified.' });
        }
        close();
        onDone();
      } catch (err) {
        form.querySelector('.form-error').textContent = err.message;
      }
    });
  });
}

function openAiSplit(ctx, onDone) {
  const start = new Date();
  const end = new Date(Date.now() + 14 * 86400000);
  const { modal, close } = openModal(`
    <h2>✨ AI jobdesk splitter</h2>
    <p class="sub">Describe the project. Gemini drafts a fair split for all ${ctx.members.length} members with staggered deadlines — you review and edit before anything is assigned.</p>
    <form id="ai-form">
      <div class="field"><label>Project brief</label><textarea class="input" name="brief" required style="min-height:120px" placeholder="e.g. Final project Pemrograman Web: build a library management website (login, CRUD books, borrowing), write a 10-page report and a 10-minute presentation. Due in 2 weeks."></textarea></div>
      <div class="row">
        <div class="field"><label>Start</label><input class="input" type="date" name="start" value="${start.toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Final deadline</label><input class="input" type="date" name="end" value="${end.toISOString().slice(0, 10)}"></div>
      </div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-violet" type="submit">Generate plan</button></div>
    </form>
    <div id="ai-result"></div>`, { wide: true });
  const form = $('#ai-form', modal);
  form.querySelector('[data-close]').onclick = close;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const err = form.querySelector('.form-error');
      err.textContent = '';
      try {
        const res = await api(`/groups/${ctx.groupId}/ai/split`, {
          method: 'POST',
          body: { brief: form.brief.value, startDate: form.start.value, endDate: form.end.value },
        });
        if (!res.missions.length) {
          err.textContent = 'The AI returned no usable missions. Try adding more detail.';
          return;
        }
        showPlan(res);
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });

  function showPlan({ missions, note }) {
    const box = $('#ai-result', modal);
    box.innerHTML = `
      <div class="section" style="margin-top:18px">
        ${note ? `<div class="ai-note" style="margin:0 0 12px"><b>Why it's fair:</b> ${esc(note)}</div>` : ''}
        <table class="ai-table">
          <thead><tr><th style="width:22%">Member</th><th>Jobdesk</th><th style="width:24%">Deadline</th><th></th></tr></thead>
          <tbody>${missions
            .map((m) => {
              const ts = Date.parse(m.deadline);
              return `<tr>
                <td><select class="input" data-f="assigneeId">${memberOptions(ctx.members, m.assigneeId)}</select></td>
                <td><input class="input" data-f="title" value="${esc(m.title)}" maxlength="120"><textarea class="input" data-f="description" style="margin-top:6px">${esc(m.description)}</textarea></td>
                <td><input class="input" type="datetime-local" data-f="deadline" value="${Number.isFinite(ts) ? toLocalInput(ts) : ''}"></td>
                <td><button class="btn btn-sm btn-ghost" data-rm title="Remove">✕</button></td>
              </tr>`;
            })
            .join('')}</tbody>
        </table>
        <div class="form-error" id="ai-save-error"></div>
        <div class="modal-actions"><button class="btn btn-primary" id="ai-save">Assign all missions</button></div>
      </div>`;
    $$('[data-rm]', box).forEach((b) => (b.onclick = () => b.closest('tr').remove()));
    $('#ai-save', box).onclick = (ev) => busy(ev.currentTarget, async () => {
      const rows = $$('tbody tr', box).map((tr) => ({
        assigneeId: Number(tr.querySelector('[data-f=assigneeId]').value),
        title: tr.querySelector('[data-f=title]').value,
        description: tr.querySelector('[data-f=description]').value,
        deadline: new Date(tr.querySelector('[data-f=deadline]').value).getTime(),
      }));
      try {
        const res = await api(`/groups/${ctx.groupId}/missions/bulk`, { method: 'POST', body: { missions: rows } });
        toast(`${res.created} missions assigned`, { body: 'Everyone has been notified.' });
        close();
        onDone();
      } catch (err) {
        $('#ai-save-error', box).textContent = err.message;
      }
    });
  }
}

function missionItem(m, ctx) {
  const mine = m.assignee.id === store.me.id;
  const cd = countdown(m.deadline);
  const canUpload = mine && ACTIVE.includes(m.status) && m.deadline > Date.now();
  const canEdit = ctx.isLeader && ACTIVE.includes(m.status);
  return `
    <div class="mission">
      <div class="mission-main">
        <p class="mission-title">${esc(m.title)}</p>
        ${m.description ? `<p class="mission-desc">${esc(m.description)}</p>` : ''}
        <div class="mission-meta">
          ${statusPill(m.status)}
          <span title="${fmtDate(m.deadline)}">📅 ${fmtDate(m.deadline)}</span>
          ${['open', 'revision'].includes(m.status) ? `<span class="countdown ${cd.cls}">${cd.text}</span>` : ''}
          ${m.latestProofId && m.review.total ? `<span>✓ ${m.review.checked}/${m.review.total} checked</span>` : ''}
        </div>
      </div>
      <div class="mission-actions">
        ${canUpload ? `<button class="btn btn-sm btn-primary" data-upload="${m.id}">${m.latestProofId ? 'Re-upload' : 'Upload proof'}</button>` : ''}
        ${m.latestProofId ? `<a class="btn btn-sm" href="#/group/${ctx.groupId}/feed">View proof</a>` : ''}
        ${canEdit ? `<button class="btn btn-sm btn-ghost" data-edit="${m.id}">Edit</button>` : ''}
        ${ctx.isLeader ? `<button class="btn btn-sm btn-ghost" data-del="${m.id}" title="Delete">🗑</button>` : ''}
      </div>
    </div>`;
}

export function renderMissions(container, ctx) {
  let missions = [];
  container.innerHTML = `
    <div class="page-head" style="margin-bottom:16px">
      <div><h1 style="font-size:22px">Missions</h1><p>Every jobdesk, who owns it, and how far it got.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="m-actions"></div>
    </div>
    <div class="rule-box" style="margin-bottom:20px">
      <b>Group rules</b>
      <ul>
        <li>Upload proof before the deadline, or <b>IPtasK Bot</b> posts your confession to the feed.</li>
        <li>Every other member must press <b>Checked</b> within <b>${ctx.group.verifyGraceHours}h</b> after the deadline. Whoever doesn't gets exposed — and so does the work owner, because the work is unverified.</li>
        <li>Reminders: daily for unfinished jobdesks, plus an H-1 warning.</li>
      </ul>
    </div>
    <div id="m-list"><div class="loading"><span class="spinner"></span></div></div>`;

  const actions = $('#m-actions', container);
  if (ctx.isLeader) {
    actions.innerHTML = `
      <button class="btn btn-violet" id="m-ai" ${ctx.aiEnabled ? '' : 'disabled title="Add GEMINI_API_KEY to .env to enable"'}>✨ AI split</button>
      <button class="btn btn-primary" id="m-add">+ Add mission</button>`;
    $('#m-add', container).onclick = () => openMissionModal(ctx, null, load);
    $('#m-ai', container).onclick = () => openAiSplit(ctx, load);
  }

  function draw() {
    const list = $('#m-list', container);
    if (!list) return;
    if (missions.length === 0) {
      list.innerHTML = `<div class="empty"><b>No missions yet</b>${ctx.isLeader ? 'Add the first jobdesk — or let the AI draft a fair split for everyone.' : 'Your leader has not assigned any jobdesks yet.'}</div>`;
      return;
    }
    list.innerHTML = ctx.members
      .map((member) => {
        const own = missions.filter((m) => m.assignee.id === member.id);
        const verified = own.filter((m) => m.status === 'verified').length;
        const pct = own.length ? Math.round((verified / own.length) * 100) : 0;
        own.sort((a, b) => ACTIVE.includes(b.status) - ACTIVE.includes(a.status) || a.deadline - b.deadline);
        return `
          <div class="card list-card member-block">
            <div class="member-head">
              ${avatar(member, 38)}
              <div><b>${esc(member.displayName)}${member.id === store.me.id ? ' (you)' : ''}</b><small>@${esc(member.username)} · ${own.length} mission${own.length === 1 ? '' : 's'}</small></div>
              <div class="progress" title="${verified}/${own.length} verified"><i style="width:${pct}%"></i></div>
              <span class="progress-label">${verified}/${own.length}</span>
            </div>
            ${own.length ? own.map((m) => missionItem(m, ctx)).join('') : '<div class="mission" style="color:var(--text-3);font-size:14px">No jobdesk assigned.</div>'}
          </div>`;
      })
      .join('');
  }

  async function load() {
    missions = (await api(`/groups/${ctx.groupId}/missions`)).missions;
    draw();
  }

  container.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const find = (id) => missions.find((m) => m.id === Number(id));
    if (b.dataset.upload) {
      const open = missions.filter((m) => m.assignee.id === store.me.id && ACTIVE.includes(m.status) && m.deadline > Date.now());
      openUploadModal(ctx, open, Number(b.dataset.upload), load);
    } else if (b.dataset.edit) {
      openMissionModal(ctx, find(b.dataset.edit), load);
    } else if (b.dataset.del) {
      const m = find(b.dataset.del);
      if (await confirmDialog('Delete mission?', `"${m.title}" and all its proof will be deleted.`, { confirmText: 'Delete', danger: true })) {
        try {
          await api(`/missions/${m.id}`, { method: 'DELETE' });
          load();
        } catch (err) {
          toast(err.message, { error: true });
        }
      }
    }
  });

  load().catch((err) => toast(err.message, { error: true }));
  const timer = setInterval(draw, 60000); // keep countdowns fresh
  const off = bus.on('missions:changed', load);
  return () => {
    off();
    clearInterval(timer);
  };
}
