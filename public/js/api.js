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
    const err = new Error(data.error || `Request failed (${res.status})`);
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

let socket = null;
export function connectSocket() {
  if (socket || typeof io === 'undefined') return socket;
  // eslint-disable-next-line no-undef
  socket = io({ withCredentials: true });
  for (const ev of ['notification', 'message', 'feed:changed', 'missions:changed', 'group:changed', 'group:deleted', 'invites:changed']) {
    socket.on(ev, (payload) => bus.emit(ev, payload));
  }
  socket.on('connect', () => bus.emit('socket:connect'));
  return socket;
}
export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
export function joinGroupRoom(groupId) {
  socket?.emit('group:join', groupId);
  const rejoin = bus.on('socket:connect', () => socket?.emit('group:join', groupId));
  return () => {
    rejoin();
    socket?.emit('group:leave', groupId);
  };
}
