import { MODES, needsVisible } from './view.js';
import { store, dragToAlign } from './visible.js';

const ICONS = {
  ir: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5" fill="currentColor" fill-opacity="0.35"/>',
  visible: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 16l5-5 5.5 5.5M13 14.5l2.5-2.5 5 5"/><circle cx="15.5" cy="8.5" r="1.3"/>',
  pip: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><rect x="11.5" y="7" width="6.5" height="5" rx="1" fill="currentColor" fill-opacity="0.35"/>',
  fusion: '<rect x="3.5" y="3.5" width="11" height="11" rx="2"/><rect x="9.5" y="9.5" width="11" height="11" rx="2"/><path d="M9.5 14.5h5v-5" fill="currentColor" fill-opacity="0.35" stroke="none"/>',
  detail: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="currentColor" fill-opacity="0.2"/><path d="M6.5 15.5c2-4 3.5-6 5.5-6s3 2.5 5.5-1"/>',
  side: '<rect x="2.5" y="6" width="9" height="12" rx="2" fill="currentColor" fill-opacity="0.35"/><rect x="12.5" y="6" width="9" height="12" rx="2"/>',
  split: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 2.5v19"/><path d="M8.5 10l-2 2 2 2M15.5 10l2 2-2 2"/>',
};

/** Wires up the Camera sheet and the on-image controls for the picture modes.
 *  ctx: { view, vis, queueDraw, flash, camera(): IX1 | null }. */
export function setupCamera({ view, vis, queueDraw, flash, camera }) {
  const $ = (id) => document.getElementById(id);
  const saved = store.get('ix1.picture', { mode: 'ir', blend: 0.5, split: 0.5, pip: view.pip, source: 'builtin' });
  view.mode = saved.mode in MODES ? saved.mode : 'ir';
  view.blend = saved.blend;
  view.split = saved.split;
  view.pip = { ...view.pip, ...saved.pip };
  let sourcePref = saved.source;
  const save = () => store.set('ix1.picture', { mode: view.mode, blend: view.blend, split: view.split, pip: view.pip, source: sourcePref });

  // ---- mode tiles ----
  const tiles = Object.entries(MODES).map(([mode, label]) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.dataset.mode = mode;
    b.innerHTML = `<span class="tile"><svg viewBox="0 0 24 24">${ICONS[mode]}</svg></span>`;
    b.append(label);
    b.onclick = () => setMode(mode);
    $('modes').append(b);
    return b;
  });

  function setMode(mode) {
    view.mode = mode;
    save();
    render();
    sync();
    queueDraw();
  }

  // ---- which visible camera ----
  const sources = [...document.querySelectorAll('[data-source]')];
  for (const b of sources) b.onclick = () => { sourcePref = b.dataset.source; save(); render(); sync(); queueDraw(); };
  const source = () => (camera()?.hasVisible && sourcePref !== 'device' ? 'builtin' : 'device');
  const wanted = () => (camera() && (needsVisible(view.mode) || view.aligning) ? source() : null);

  let syncing = Promise.resolve();
  let lastError = '';
  /** Starts or stops the visible camera to match the mode. */
  function sync() {
    const want = wanted();
    syncing = syncing.then(async () => {
      try {
        await vis.use(want);
        lastError = '';
      } catch (e) {
        if (e.message !== lastError) flash(`Visible camera: ${e.message}`, 'error');
        lastError = e.message;
      }
      queueDraw();
    });
    return syncing;
  }
  vis.onerror = (msg) => flash(`Visible camera: ${msg}`, 'error');

  // ---- blend slider (Fusion and Detail) ----
  const blend = $('blend');
  blend.oninput = () => {
    view.blend = blend.value / 100;
    $('blend-val').textContent = blend.value;
    queueDraw();
  };
  blend.onchange = save;

  // ---- picture-in-picture box: drag to move, drag the corner to resize, wheel to resize ----
  const pipBox = $('pip-box');
  let pipDrag = null;
  pipBox.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('#pip-swap')) return;
    const [, , w, h] = view.layout.ir;
    const c = view.cssPerPx;
    pipDrag = { x: e.clientX, y: e.clientY, p: { ...view.pip }, W: w * c, H: h * c, resize: !!e.target.closest('.pip-resize') };
    pipBox.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  pipBox.addEventListener('pointermove', (e) => {
    if (!pipDrag) return;
    const { p, W, H } = pipDrag;
    const dx = (e.clientX - pipDrag.x) / W, dy = (e.clientY - pipDrag.y) / H;
    if (pipDrag.resize) view.pip.w = p.w + (dx + dy) / 2;
    else { view.pip.x = p.x + dx; view.pip.y = p.y + dy; }
    queueDraw();
  });
  const endPip = () => { if (pipDrag) { pipDrag = null; save(); } };
  pipBox.addEventListener('pointerup', endPip);
  pipBox.addEventListener('pointercancel', endPip);
  pipBox.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = view.pip, w0 = p.w;
    p.w *= Math.exp(-e.deltaY * 0.0015);
    p.w = Math.min(Math.max(p.w, 0.15), 0.9);
    // Grow and shrink around the box's centre.
    p.x -= (p.w - w0) / 2;
    p.y -= (p.w - w0) / 2;
    queueDraw();
    clearTimeout(pipBox.saveTimer);
    pipBox.saveTimer = setTimeout(save, 300);
  }, { passive: false });
  $('pip-swap').onclick = () => { view.pip.swap = !view.pip.swap; save(); queueDraw(); };

  // ---- slider handle ----
  const splitBar = $('split-bar');
  let splitting = false;
  const splitTo = (e) => {
    const r = view.canvas.getBoundingClientRect();
    const w = view.layout.ir[2] * view.cssPerPx;
    view.split = Math.min(Math.max((e.clientX - r.left) / w, 0), 1);
    queueDraw();
  };
  splitBar.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    splitting = true;
    splitBar.setPointerCapture(e.pointerId);
    splitTo(e);
    e.preventDefault();
  });
  splitBar.addEventListener('pointermove', (e) => splitting && splitTo(e));
  const endSplit = () => { if (splitting) { splitting = false; save(); } };
  splitBar.addEventListener('pointerup', endSplit);
  splitBar.addEventListener('pointercancel', endSplit);

  // ---- lining up the two cameras ----
  const layer = $('align-layer');
  const zoom = $('align-zoom');
  const pointers = new Map();
  let gesture = null;

  function setAligning(on) {
    view.aligning = on;
    if (!on) vis.saveAlign();
    render();
    sync();
    queueDraw();
  }
  $('align').onclick = () => setAligning(!view.aligning);
  $('align-done').onclick = () => setAligning(false);
  $('align-reset').onclick = () => { vis.resetAlign(); render(); queueDraw(); };
  $('align-rot').onclick = () => { vis.cal.rot = (vis.cal.rot + 1) % 4; vis.saveAlign(); queueDraw(); };
  $('align-flip').onclick = () => { vis.cal.flip = !vis.cal.flip; vis.saveAlign(); queueDraw(); };
  zoom.oninput = () => { vis.cal.s = zoom.value / 100; queueDraw(); };
  zoom.onchange = () => vis.saveAlign();

  const setZoom = (s) => {
    vis.cal.s = Math.min(Math.max(s, 0.5), 3);
    zoom.value = Math.round(vis.cal.s * 100);
  };
  const centroid = () => {
    let x = 0, y = 0;
    for (const p of pointers.values()) { x += p.x; y += p.y; }
    return [x / pointers.size, y / pointers.size];
  };
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const startGesture = () => {
    gesture = pointers.size ? { c: centroid(), d: spread(), s: vis.cal.s, x: vis.cal.x, y: vis.cal.y } : null;
  };
  layer.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    layer.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
    e.preventDefault();
  });
  layer.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const c = view.cssPerPx;
    const W = view.layout.ir[2] * c, H = view.layout.ir[3] * c;
    const [cx, cy] = centroid();
    const [dx, dy] = dragToAlign(vis, view, (cx - gesture.c[0]) / W, (cy - gesture.c[1]) / H);
    vis.cal.x = gesture.x + dx;
    vis.cal.y = gesture.y + dy;
    if (gesture.d > 10 && pointers.size > 1) setZoom((gesture.s * spread()) / gesture.d);
    queueDraw();
  });
  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    startGesture();
    if (!pointers.size) vis.saveAlign();
  };
  layer.addEventListener('pointerup', endPointer);
  layer.addEventListener('pointercancel', endPointer);
  layer.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(vis.cal.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    queueDraw();
    clearTimeout(layer.saveTimer);
    layer.saveTimer = setTimeout(() => vis.saveAlign(), 300);
  }, { passive: false });

  /** Arrow keys nudge the alignment, +/- zoom; returns true if it used the key. */
  function alignKey(e) {
    if (!view.aligning) return false;
    const step = e.shiftKey ? 0.01 : 0.002;
    const nudge = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[e.key.toLowerCase()];
    if (nudge) {
      const [dx, dy] = dragToAlign(vis, view, ...nudge);
      vis.cal.x += dx;
      vis.cal.y += dy;
    } else if (e.key === '+' || e.key === '=') setZoom(vis.cal.s * 1.01);
    else if (e.key === '-') setZoom(vis.cal.s / 1.01);
    else if (e.key === 'Enter' || e.key === 'Escape') { setAligning(false); return true; }
    else return false;
    vis.saveAlign();
    queueDraw();
    return true;
  }

  // ---- sheet and overlay state ----
  function render() {
    const mode = view.mode;
    for (const b of tiles) b.classList.toggle('active', b.dataset.mode === mode);
    const hasBuiltin = !!camera()?.hasVisible;
    $('vis-source').hidden = !hasBuiltin;
    for (const b of sources) b.classList.toggle('active', b.dataset.source === source());
    $('align').classList.toggle('active', view.aligning);
    $('align').disabled = !camera();
    blend.value = Math.round(view.blend * 100);
    $('blend-val').textContent = blend.value;
    $('blend-label').textContent = mode === 'detail' ? 'Detail' : 'Thermal';
    zoom.value = Math.round(vis.cal.s * 100);
    document.querySelector('.stage').classList.toggle('aligning', view.aligning);
    place();
  }

  /** Positions the DOM handles over the canvas; called after every draw. */
  function place() {
    const live = !!camera() && !!view.image;
    const mode = view.shownMode;
    const c = view.cssPerPx;
    const [, , w, h] = view.layout.ir;
    const show = (el, on) => { if (el.hidden === on) el.hidden = !on; };
    show($('blend-bar'), live && !view.aligning && (mode === 'fusion' || mode === 'detail'));
    show($('align-bar'), live && view.aligning);
    show(layer, live && view.aligning);
    show(splitBar, live && mode === 'split');
    show(pipBox, live && mode === 'pip' && !!view.layout.pip);
    if (view.aligning) Object.assign(layer.style, { width: `${w * c}px`, height: `${h * c}px` });
    if (mode === 'split') Object.assign(splitBar.style, { left: `${w * view.split * c}px`, height: `${h * c}px` });
    if (mode === 'pip' && view.layout.pip) {
      const [px, py, pw, ph] = view.layout.pip;
      Object.assign(pipBox.style, { left: `${px * c}px`, top: `${py * c}px`, width: `${pw * c}px`, height: `${ph * c}px` });
    }
  }

  render();

  return {
    update: place,
    /** Call when the camera connects or disconnects. */
    refresh() {
      if (!camera() && view.aligning) view.aligning = false;
      render();
      return sync();
    },
    /** Whether JPEGs from the camera's own visible stream are wanted right now. */
    get wantsBuiltin() { return wanted() === 'builtin'; },
    nextMode() {
      const modes = Object.keys(MODES);
      setMode(modes[(modes.indexOf(view.mode) + 1) % modes.length]);
    },
    alignKey,
  };
}
