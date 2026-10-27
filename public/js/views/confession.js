import { esc, avatar, colorFor, initials, openModal, timeAgo } from '../ui.js';

const KIND_LABEL = {
  missed_deadline: 'Missed deadline',
  unchecked: "Didn't check a teammate",
  unverified: 'Work not verified',
};

export function quoteCardHtml(c, groupName = '') {
  return `
    <div class="quote-card">
      <div class="quote-photo">${avatar(c.user, 300)}</div>
      <div class="quote-text-wrap">
        <p class="quote-text">“${esc(c.quote)}”</p>
        <p class="quote-author">— ${esc(c.user.displayName)}</p>
        <p class="quote-handle">@${esc(c.user.username)}</p>
        ${c.roast ? `<p class="quote-roast">${esc(c.roast)}</p>` : ''}
      </div>
      <span class="quote-meta">IPtasK${c.missionTitle ? ` · ${esc(c.missionTitle)}` : ''}${groupName ? ` · ${esc(groupName)}` : ''}</span>
    </div>`;
}

export function confessionTweetHtml(c) {
  return `
    <article class="tweet bot" data-confession="${c.id}">
      <div class="bot-avatar">🤖</div>
      <div class="tweet-body">
        <div class="tweet-head">
          <b>IPtasK Bot</b> <span class="bot-badge">BOT</span>
          <span class="dot">·</span><time>${timeAgo(c.createdAt)}</time>
        </div>
        <div class="tweet-mission">
          <span class="pill failed">${KIND_LABEL[c.kind] || 'Confession'}</span>
          ${c.missionTitle ? `<span>on <strong>${esc(c.missionTitle)}</strong></span>` : ''}
        </div>
        ${quoteCardHtml(c)}
        <div class="quote-actions">
          <button class="btn btn-sm btn-ghost" data-download="${c.id}">⬇ Save as image</button>
        </div>
      </div>
    </article>`;
}

export function openStory(c) {
  const { modal } = openModal(`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;color:#fff">
      <span class="bot-avatar" style="width:34px;height:34px;font-size:17px">🤖</span>
      <div style="flex:1"><b>IPtasK Bot</b> <small style="color:var(--text-3)">in ${esc(c.groupName || '')} · ${timeAgo(c.createdAt)}</small></div>
      <button class="btn btn-sm" data-dl>⬇ Save</button>
      <button class="btn btn-sm btn-ghost" data-close>✕</button>
    </div>
    ${quoteCardHtml(c, c.groupName)}`, { className: 'story-modal' });
  modal.querySelector('[data-dl]').onclick = () => downloadConfession(c, c.groupName);
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Render the quote card to a 1200×600 PNG, so it can be shared outside the app. */
export async function downloadConfession(c, groupName = '') {
  const W = 1200;
  const H = 600;
  const PHOTO = 540;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.filter = 'grayscale(1)';
  const img = c.user.avatarUrl ? await loadImage(c.user.avatarUrl) : null;
  if (img) {
    const scale = Math.max(PHOTO / img.width, H / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (PHOTO - w) / 2, (H - h) / 2, w, h);
  } else {
    ctx.fillStyle = colorFor(c.user.username);
    ctx.fillRect(0, 0, PHOTO, H);
    ctx.fillStyle = '#0a0b10';
    ctx.font = 'bold 200px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(c.user.displayName), PHOTO / 2, H / 2);
  }
  ctx.restore();

  const fade = ctx.createLinearGradient(PHOTO * 0.35, 0, PHOTO, 0);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, '#000');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, PHOTO, H);

  const cx = PHOTO + (W - PHOTO) / 2 - 10;
  const maxW = W - PHOTO - 90;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = 'italic 44px Georgia, "Times New Roman", serif';
  const lines = wrapLines(ctx, `“${c.quote}”`, maxW);
  const lineH = 56;
  let y = H / 2 - ((lines.length - 1) * lineH) / 2 - (c.roast ? 50 : 30);
  for (const l of lines) {
    ctx.fillText(l, cx, y);
    y += lineH;
  }
  y += 8;
  ctx.font = '28px Inter, Arial, sans-serif';
  ctx.fillText(`— ${c.user.displayName}`, cx, y);
  ctx.font = '22px Inter, Arial, sans-serif';
  ctx.fillStyle = '#8a8a8a';
  ctx.fillText(`@${c.user.username}`, cx, y + 34);
  if (c.roast) {
    ctx.fillStyle = '#c9c9c9';
    ctx.font = '22px Inter, Arial, sans-serif';
    wrapLines(ctx, c.roast, maxW).forEach((l, i) => ctx.fillText(l, cx, y + 86 + i * 30));
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = '#555';
  ctx.font = '18px Inter, Arial, sans-serif';
  ctx.fillText(['IPtasK', c.missionTitle, groupName].filter(Boolean).join(' · '), W - 24, H - 22);

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `iptask-confession-${c.user.username}-${c.id}.png`;
  a.click();
}
