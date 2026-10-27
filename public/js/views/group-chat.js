import { api, bus } from '../api.js';
import { store } from '../state.js';
import { $, esc, avatar, fmtClock, toast } from '../ui.js';

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function renderChat(container, ctx) {
  container.innerHTML = `
    <div class="chat">
      <div class="chat-scroll" id="chat-scroll"><div class="loading"><span class="spinner"></span></div></div>
      <form class="composer" id="chat-form">
        <textarea class="input" rows="1" placeholder="Message ${esc(ctx.group.name)}…" maxlength="2000"></textarea>
        <button class="btn btn-primary">Send</button>
      </form>
    </div>`;
  const scroller = $('#chat-scroll', container);
  const form = $('#chat-form', container);
  const input = form.querySelector('textarea');
  let messages = [];
  let oldestId = null;
  let loadingOlder = false;
  let reachedStart = false;

  function render({ keepOffset = false } = {}) {
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    if (messages.length === 0) {
      scroller.innerHTML = '<div class="empty" style="margin:auto">Say hi to your team 👋<br>Proof of work goes in the <b style="display:inline">Proof feed</b> tab.</div>';
      return;
    }
    let html = '';
    let lastDay = '';
    let lastUser = null;
    let lastTs = 0;
    for (const m of messages) {
      const day = dayLabel(m.createdAt);
      if (day !== lastDay) {
        html += `<div class="chat-day">${day}</div>`;
        lastDay = day;
        lastUser = null;
      }
      const mine = m.user.id === store.me.id;
      const grouped = lastUser === m.user.id && m.createdAt - lastTs < 5 * 60000;
      html += `
        <div class="msg ${mine ? 'me' : ''}">
          <div class="avatar-slot">${!mine && !grouped ? avatar(m.user, 30) : ''}</div>
          <div>
            ${!grouped ? `<div class="who">${mine ? 'You' : esc(m.user.displayName)}</div>` : ''}
            <div class="bubble">${esc(m.body)}</div>
            <div class="time">${fmtClock(m.createdAt)}</div>
          </div>
        </div>`;
      lastUser = m.user.id;
      lastTs = m.createdAt;
    }
    scroller.innerHTML = html;
    scroller.scrollTop = keepOffset ? scroller.scrollHeight - prevHeight + prevTop : scroller.scrollHeight;
  }

  async function loadInitial() {
    const data = await api(`/groups/${ctx.groupId}/messages`);
    messages = data.messages;
    oldestId = messages[0]?.id ?? null;
    reachedStart = messages.length < 50;
    render();
  }

  scroller.addEventListener('scroll', async () => {
    if (scroller.scrollTop > 60 || loadingOlder || reachedStart || !oldestId) return;
    loadingOlder = true;
    const data = await api(`/groups/${ctx.groupId}/messages?before=${oldestId}`);
    loadingOlder = false;
    if (data.messages.length === 0) {
      reachedStart = true;
      return;
    }
    messages = [...data.messages, ...messages];
    oldestId = messages[0].id;
    reachedStart = data.messages.length < 50;
    render({ keepOffset: true });
  });

  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    input.style.height = '';
    try {
      await api(`/groups/${ctx.groupId}/messages`, { method: 'POST', body: { body } });
    } catch (err) {
      input.value = body;
      toast(err.message, { error: true });
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  const off = bus.on('message', (m) => {
    if (m.groupId !== ctx.groupId || messages.some((x) => x.id === m.id)) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    messages.push(m);
    render({ keepOffset: !nearBottom && m.user.id !== store.me.id });
  });

  loadInitial().catch((err) => toast(err.message, { error: true }));
  input.focus();
  return off;
}
