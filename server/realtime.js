import { Server } from 'socket.io';
import { userFromCookieHeader } from './auth.js';
import { one, run } from './db.js';

let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer);

  io.use((socket, next) => {
    userFromCookieHeader(socket.handshake.headers.cookie)
      .then((user) => {
        if (!user) return next(new Error('unauthorized'));
        socket.data.userId = user.id;
        next();
      })
      .catch(next);
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);

    socket.on('group:join', async (groupId) => {
      try {
        const member = await one(
          'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?',
          Number(groupId), socket.data.userId
        );
        if (member) socket.join(`group:${Number(groupId)}`);
      } catch (err) {
        console.error('[socket] group:join', err.message);
      }
    });

    socket.on('group:leave', (groupId) => socket.leave(`group:${Number(groupId)}`));
  });
}

export function emitToUser(userId, event, payload = {}) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToGroup(groupId, event, payload = {}) {
  io?.to(`group:${groupId}`).emit(event, payload);
}

export async function notify(userId, { type, title, body = '', link = null, actorId = null }) {
  const info = await run(
    `INSERT INTO notifications (user_id, type, title, body, link, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, type, title, body, link, actorId, Date.now()
  );
  emitToUser(userId, 'notification', { id: Number(info.lastInsertRowid), type, title, body, link });
}
