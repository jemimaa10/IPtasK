// Profile photo editor: crop (drag, zoom, rotate) → check the result → confirm.
// Resolves with a 512×512 JPEG Blob when the user confirms, or null when they cancel.
import { openModal, esc } from './ui.js';

const STAGE = 280;   // on-screen crop square (CSS px)
const OUTPUT = 512;  // saved avatar size
const MAX_ZOOM = 4;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file couldn't be opened as an image."));
    };
    img.src = url;
  });
}

export async function cropAvatar(file, { name = '', group = false } = {}) {
  const { img, url } = await loadImage(file);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // Image placement: rotation (quarter turns), zoom (1 = just covers the circle), offset of its centre from the stage centre.
  const st = { rot: 0, zoom: 1, x: 0, y: 0 };
  const dims = () => (st.rot % 2 ? [H, W] : [W, H]);
  const scale = () => (STAGE / Math.min(...dims())) * st.zoom;
  function clamp() {
    const [w, h] = dims();
    const s = scale();
    const mx = Math.max(0, (w * s - STAGE) / 2);
    const my = Math.max(0, (h * s - STAGE) / 2);
    st.x = Math.min(mx, Math.max(-mx, st.x));
    st.y = Math.min(my, Math.max(-my, st.y));
  }

  /** Draws the current crop onto ctx, whose canvas is `size` px square. */
  function paint(ctx, size) {
    const k = size / STAGE;
    ctx.save();
    ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background in the JPEG
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2 + st.x * k, size / 2 + st.y * k);
    ctx.rotate((st.rot * Math.PI) / 2);
    const s = scale() * k;
    ctx.scale(s, s);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -W / 2, -H / 2);
    ctx.restore();
  }

  const { modal, close } = openModal(`
    <div class="crop-step" data-step="crop">
      <h2>${group ? 'Adjust the group photo' : 'Adjust your photo'}</h2>
      <p class="sub">Drag to move, use the slider (or pinch / scroll) to zoom. Only the part inside the ${group ? 'frame' : 'circle'} is used.</p>
      <div class="crop-stage" tabindex="0" aria-label="Photo crop area. Arrow keys move, plus and minus zoom.">
        <canvas></canvas>
        <div class="crop-mask" aria-hidden="true"></div>
      </div>
      <div class="crop-tools">
        <span aria-hidden="true">−</span>
        <input type="range" class="crop-zoom" min="1" max="${MAX_ZOOM}" step="0.01" value="1" aria-label="Zoom">
        <span aria-hidden="true">+</span>
        <button class="btn btn-ghost btn-sm" type="button" data-rotate title="Rotate">⟳ Rotate</button>
        <button class="btn btn-ghost btn-sm" type="button" data-reset>Reset</button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
        <button class="btn btn-primary" type="button" data-next>Next</button>
      </div>
    </div>
    <div class="crop-step" data-step="check" hidden>
      <h2>Use this photo?</h2>
      <p class="sub">${group ? 'This is how every member will see the group.' : 'This is how your group will see you.'} Nothing changes until you confirm.</p>
      <div class="crop-check">
        <img class="crop-big" alt="New profile photo">
        <div class="crop-samples">
          <div class="crop-sample"><img alt=""><div><b>${esc(name)}</b><span>${group ? 'Your groups' : 'Uploaded proof · just now'}</span></div></div>
          <div class="crop-sample small"><img alt=""><span>${esc(name)}</span></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" data-back>Back to edit</button>
        <button class="btn btn-primary" type="button" data-ok>Use this photo</button>
      </div>
    </div>`, { className: `crop-modal${group ? ' crop-group' : ''}` });

  const canvas = modal.querySelector('canvas');
  const stage = modal.querySelector('.crop-stage');
  const zoom = modal.querySelector('.crop-zoom');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = canvas.height = Math.round(STAGE * dpr);
  const ctx = canvas.getContext('2d');
  const draw = () => {
    clamp();
    paint(ctx, canvas.width);
  };

  function setZoom(z, cx = 0, cy = 0) {
    // Zoom around a point (relative to the stage centre) so it stays under the finger / cursor.
    const next = Math.min(MAX_ZOOM, Math.max(1, z));
    const ratio = next / st.zoom;
    st.x = cx + (st.x - cx) * ratio;
    st.y = cy + (st.y - cy) * ratio;
    st.zoom = next;
    zoom.value = String(next);
    draw();
  }
  const stagePoint = (e) => {
    const r = stage.getBoundingClientRect();
    const k = STAGE / r.width;
    return [(e.clientX - r.left - r.width / 2) * k, (e.clientY - r.top - r.height / 2) * k];
  };

  // Drag with one pointer, pinch with two.
  const pointers = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: st.zoom };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const k = STAGE / stage.getBoundingClientRect().width;
    if (pointers.size === 1) {
      st.x += (e.clientX - prev[0]) * k;
      st.y += (e.clientY - prev[1]) * k;
      draw();
    } else if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = stagePoint({ clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 });
      setZoom((pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.dist, ...mid);
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(st.zoom * Math.exp(-e.deltaY * 0.0015), ...stagePoint(e));
  }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    const step = 10;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      st.x += moves[e.key][0];
      st.y += moves[e.key][1];
      draw();
    } else if (e.key === '+' || e.key === '=') setZoom(st.zoom + 0.1);
    else if (e.key === '-') setZoom(st.zoom - 0.1);
    else return;
    e.preventDefault();
  });
  zoom.addEventListener('input', () => setZoom(Number(zoom.value)));
  modal.querySelector('[data-rotate]').addEventListener('click', () => {
    st.rot = (st.rot + 1) % 4;
    [st.x, st.y] = [-st.y, st.x];
    draw();
  });
  modal.querySelector('[data-reset]').addEventListener('click', () => {
    Object.assign(st, { rot: 0, zoom: 1, x: 0, y: 0 });
    zoom.value = '1';
    draw();
  });
  draw();
  stage.focus({ focusVisible: false });

  return new Promise((resolve) => {
    let result = null;
    let previewUrl = null;
    const show = (step) => modal.querySelectorAll('.crop-step').forEach((s) => { s.hidden = s.dataset.step !== step; });

    modal.querySelector('[data-cancel]').addEventListener('click', close);
    modal.querySelector('[data-next]').addEventListener('click', () => {
      const out = document.createElement('canvas');
      out.width = out.height = OUTPUT;
      paint(out.getContext('2d'), OUTPUT);
      out.toBlob((blob) => {
        if (!blob) return;
        result = blob;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(blob);
        modal.querySelectorAll('[data-step="check"] img').forEach((i) => { i.src = previewUrl; });
        show('check');
        modal.querySelector('[data-ok]').focus();
      }, 'image/jpeg', 0.9);
    });
    modal.querySelector('[data-back]').addEventListener('click', () => {
      result = null;
      show('crop');
      stage.focus();
    });
    let confirmed = false;
    modal.querySelector('[data-ok]').addEventListener('click', () => {
      confirmed = true;
      close();
    });

    // Resolve whichever way the modal closes (buttons, Esc, backdrop click).
    new MutationObserver((_, obs) => {
      if (modal.isConnected) return;
      obs.disconnect();
      URL.revokeObjectURL(url);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      resolve(confirmed ? result : null);
    }).observe(document.getElementById('modal-root'), { childList: true });
  });
}
