export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status === 413 ? 'The upload is too large (4 MB max).' : `Request failed (${res.status})`;
    const err = new Error(data.error || fallback);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Tiny event bus so views can react to socket events without knowing about sockets. */
const listeners = new Map();
export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) {
    listeners.get(event)?.forEach((fn) => fn(payload));
  },
};

// ---------- live updates ----------
// Long polling: GET /api/events waits on the server until something happens (or ~20 s pass),
// then the next request starts right away. Paused while the tab is hidden; catches up when it is shown again.
const openGroups = new Map(); // groupId -> number of views showing it
let session = null; // { controller } while connected
let cursor = 0; // last event seen; 0 = ask the server where to start

async function pollLoop(current) {
  let failures = 0;
  while (session === current) {
    if (document.hidden) {
      await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
      continue;
    }
    try {
      const groups = [...openGroups.keys()].join(',');
      const res = await fetch(`/api/events?since=${cursor}&groups=${groups}`, {
        credentials: 'same-origin',
        signal: current.controller.signal,
      });
      if (res.status === 401) return; // logged out
      if (!res.ok) throw new Error(`events ${res.status}`);
      const data = await res.json();
      if (session !== current) return;
      if (cursor === 0) bus.emit('live:connect'); // first answer: views may have missed something while offline
      cursor = data.cursor;
      failures = 0;
      for (const e of data.events) {
        // Group events only reach pages that show that group, like a chat room (group:deleted always does).
        if (e.payload.groupId && e.type !== 'group:deleted' && !openGroups.has(e.payload.groupId)) continue;
        bus.emit(e.type, e.payload);
      }
    } catch (err) {
      if (session !== current) return;
      failures++;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * failures)));
    }
  }
}

/** Start live updates for the logged-in user (safe to call more than once). */
export function connectLive() {
  if (session) return;
  session = { controller: new AbortController() };
  pollLoop(session);
}

/** Stop live updates (logout, or the account changed in another tab). */
export function disconnectLive() {
  session?.controller.abort();
  session = null;
  cursor = 0;
}

/** A group view is open: receive its chat, feed and mission updates. Returns the "leave" function. */
export function joinGroupRoom(id) {
  const groupId = Number(id);
  openGroups.set(groupId, (openGroups.get(groupId) || 0) + 1);
  restartPoll(); // pick up the new group without waiting for the current poll to time out
  return () => {
    const n = (openGroups.get(groupId) || 1) - 1;
    if (n <= 0) openGroups.delete(groupId);
    else openGroups.set(groupId, n);
  };
}

function restartPoll() {
  if (!session) return;
  session.controller.abort(); // the cursor stays, so nothing in between is missed
  session = null;
  connectLive();
}
