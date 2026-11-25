import { KINDS, GLOBALS, METRICS, geometry, setGeometry, translate, hitTest, diffLabel, fmtDelta } from './measure.js';

const f1 = (t) => t.toFixed(1);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Wires up the Measure sheet and on-image editing. probe: { enabled(): bool }. */
export function setupMeasure(view, { queueDraw, probe }) {
  const $ = (id) => document.getElementById(id);
  const m = view.measure;
  const canvas = view.canvas;
  const svg = $('edit');
  const del = $('m-del');
  const list = $('m-list');
  let armed = null;
  let drag = null;
  let overlayKey = '';

  // ---- sheet ----
  const tools = [...document.querySelectorAll('[data-tool]')];
  for (const b of tools) {
    b.onclick = () => {
      if (b.dataset.tool === 'diff') return openDiffDialog();
      arm(armed === b.dataset.tool ? null : b.dataset.tool);
    };
  }
  $('m-clear').onclick = () => m.clear();

  function arm(tool) {
    armed = tool;
    if (tool) m.selected = null;
    canvas.classList.toggle('drawing', !!tool);
    m.changed();
  }

  let rows = [];
  function renderSheet() {
    for (const b of tools) b.classList.toggle('active', b.dataset.tool === armed);
    $('m-clear').disabled = m.empty;
    list.replaceChildren();
    rows = [...m.items, ...m.diffs].map((obj) => {
      const row = document.createElement('div');
      row.className = 'mitem';
      row.classList.toggle('sel', obj === m.selected);
      const name = document.createElement('button');
      name.className = 'mname';
      name.textContent = obj.kind === 'diff' ? diffLabel(obj) : obj.name;
      name.onclick = () => { arm(null); m.select(obj === m.selected ? null : obj); };
      const vals = document.createElement('span');
      vals.className = 'mvals';
      const x = document.createElement('button');
      x.className = 'mx';
      x.ariaLabel = `Remove ${name.textContent}`;
      x.innerHTML = '<svg><use href="#i-close"/></svg>';
      x.onclick = () => m.remove(obj);
      row.append(name, vals, x);
      list.append(row);
      return { obj, vals };
    });
    updateValues();
  }

  function updateValues() {
    for (const { obj, vals } of rows) {
      let text = '–';
      if (obj.kind === 'diff') text = fmtDelta(obj.value);
      else if (obj.stats) text = obj.kind === 'point' ? `${f1(obj.stats.avg)}°C` : `▲${f1(obj.stats.max)} ▼${f1(obj.stats.min)} avg ${f1(obj.stats.avg)}`;
      if (vals.textContent !== text) vals.textContent = text;
    }
  }

  m.onchange = () => { renderSheet(); overlayKey = ''; queueDraw(); };

  // ---- selection overlay (DOM, so handles never end up in photos or videos) ----
  function renderOverlay() {
    const sel = m.selected;
    if (!sel || !view.image) {
      if (overlayKey !== 'none') { svg.replaceChildren(); del.hidden = true; overlayKey = 'none'; }
      return;
    }
    const k = view.cssScale;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    let box, handles = [];
    if (sel.kind === 'diff') {
      if (!sel.box) return;
      const c = W / canvas.width;
      box = sel.box.map((v) => v * c);
    } else {
      const g = geometry(sel, view);
      box = g.box.map((v) => v * k);
      handles = g.handles.map(([x, y]) => [x * k, y * k]);
      if (sel.kind === 'point') box = [box[0] - 12, box[1] - 12, box[2] + 12, box[3] + 12];
    }
    const key = JSON.stringify([sel.id, box.map(Math.round), handles.map((p) => p.map(Math.round)), W]);
    if (key === overlayKey) return;
    overlayKey = key;

    const el = (tag, attrs) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v);
      return e;
    };
    svg.replaceChildren();
    if (sel.kind === 'circle') {
      const g = geometry(sel, view);
      svg.append(el('circle', { cx: g.c[0] * k, cy: g.c[1] * k, r: g.r * k, class: 'sel-outline' }));
    } else if (sel.kind === 'line') {
      const [a, b] = handles;
      svg.append(el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'sel-outline' }));
    } else {
      svg.append(el('rect', { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1], rx: sel.kind === 'rect' ? 0 : 6, class: 'sel-outline' }));
    }
    for (const [x, y] of handles) svg.append(el('circle', { cx: x, cy: y, r: 7, class: 'sel-handle' }));

    // Delete button just outside the selection, kept inside the image. A point's label sits above-right of
    // it, so its button goes below-right; other labels sit above-left, so theirs goes above-right.
    const size = 32;
    const top = sel.kind === 'point' ? box[3] + 6 : box[1] - size - 6;
    del.style.left = `${Math.min(Math.max(box[2] + 6, 0), W - size)}px`;
    del.style.top = `${Math.min(Math.max(top, 0), H - size)}px`;
    del.ariaLabel = `Remove ${sel.kind === 'diff' ? diffLabel(sel) : sel.name}`;
    del.hidden = false;
  }
  del.onclick = () => m.selected && m.remove(m.selected);

  // ---- pointer editing ----
  const tolerance = (e) => (e.pointerType === 'mouse' ? 8 : 18) / view.cssScale;

  function startCreate(kind, pos) {
    const S = view.toSensor(pos);
    const geom = { point: { p: S }, line: { a: S, b: S }, rect: { a: S, b: S }, circle: { c: S, r: 0 } }[kind];
    const item = m.add(kind, geom);
    const g0 = geometry(item, view);
    drag = { obj: item, start: pos, g0, handle: kind === 'point' ? -1 : kind === 'rect' ? 2 : kind === 'line' ? 1 : 0, create: true };
    arm(null);
  }

  /** A tap (no drag) with a shape tool places a default-sized shape centred on the tap. */
  function finishCreate(item) {
    const g = geometry(item, view);
    const { width: W, height: H } = view.image;
    const size = Math.min(W, H);
    const [px, py] = drag.start;
    const clampX = (v) => Math.min(Math.max(v, 0), W), clampY = (v) => Math.min(Math.max(v, 0), H);
    if (item.kind === 'line' && Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) < 2) {
      const half = size * 0.2;
      setGeometry(item, { a: [clampX(px - half), py], b: [clampX(px + half), py] }, view);
    } else if (item.kind === 'rect' && (g.box[2] - g.box[0] < 2 || g.box[3] - g.box[1] < 2)) {
      const half = size * 0.15;
      const x0 = Math.min(Math.max(px - half, 0), W - 2 * half), y0 = Math.min(Math.max(py - half, 0), H - 2 * half);
      setGeometry(item, { box: [x0, y0, x0 + 2 * half, y0 + 2 * half] }, view);
    } else if (item.kind === 'circle' && g.r < 1.5) {
      setGeometry(item, { c: [clampX(px), clampY(py)], r: size * 0.15 }, view);
    }
  }

  function updateDrag(pos) {
    const { obj, g0, handle, start } = drag;
    const { width: W, height: H } = view.image;
    let g;
    if (handle < 0) {
      // Move, keeping the shape (or a circle's centre) inside the image.
      const b = obj.kind === 'circle' ? [g0.c[0], g0.c[1], g0.c[0], g0.c[1]] : g0.box;
      const dx = Math.min(Math.max(pos[0] - start[0], -b[0]), W - b[2]);
      const dy = Math.min(Math.max(pos[1] - start[1], -b[1]), H - b[3]);
      g = translate(g0, dx, dy);
    } else if (obj.kind === 'line') {
      g = handle === 0 ? { a: pos, b: g0.b } : { a: g0.a, b: pos };
    } else if (obj.kind === 'rect') {
      const o = g0.handles[(handle + 2) % 4];
      g = { box: [Math.min(o[0], pos[0]), Math.min(o[1], pos[1]), Math.max(o[0], pos[0]), Math.max(o[1], pos[1])] };
    } else {
      g = { c: g0.c, r: Math.max(0.5, Math.hypot(pos[0] - g0.c[0], pos[1] - g0.c[1])) };
    }
    setGeometry(obj, g, view);
  }

  function setCursor(e) {
    if (armed) return (canvas.style.cursor = '');
    const hit = hitTest(m, view, view.imageCoordAt(e), view.canvasPointAt(e), tolerance(e));
    canvas.style.cursor = drag ? (drag.handle >= 0 ? 'grabbing' : 'move') : !hit ? '' : hit.handle >= 0 ? 'grab' : hit.obj.kind === 'diff' ? 'pointer' : 'move';
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!view.image || e.button > 0) return;
    const pos = view.imageCoordAt(e);
    if (armed) {
      startCreate(armed, pos);
    } else {
      const hit = hitTest(m, view, pos, view.canvasPointAt(e), tolerance(e));
      if (hit) {
        if (hit.obj !== m.selected) m.select(hit.obj);
        if (hit.obj.kind !== 'diff') drag = { obj: hit.obj, start: pos, g0: geometry(hit.obj, view), handle: hit.handle };
      } else {
        if (m.selected) m.select(null);
        if (probe.enabled()) view.probe = view.imagePointAt(e);
      }
    }
    if (drag) {
      canvas.setPointerCapture(e.pointerId);
      view.probe = null;
      setCursor(e);
    }
    queueDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!view.image) return;
    if (drag) {
      updateDrag(view.imageCoordAt(e));
      queueDraw();
      return;
    }
    if (e.pointerType === 'mouse') setCursor(e);
    if ((e.pointerType === 'mouse' || e.buttons) && probe.enabled() && !armed) {
      view.probe = view.imagePointAt(e);
      queueDraw();
    }
  });

  const endDrag = (e) => {
    if (!drag) return;
    if (drag.create) finishCreate(drag.obj);
    drag = null;
    m.changed();
    if (e.pointerType === 'mouse') setCursor(e);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !drag) { view.probe = null; queueDraw(); }
  });

  // ---- temperature difference dialog ----
  const dlg = $('diff-dlg');
  const sel = { a: $('diff-a'), am: $('diff-am'), b: $('diff-b'), bm: $('diff-bm') };
  for (const s of [sel.am, sel.bm]) {
    for (const [v, label] of Object.entries(METRICS)) s.add(new Option(label, v));
  }

  function fillSources(select, value) {
    select.replaceChildren();
    if (m.items.length) {
      const og = document.createElement('optgroup');
      og.label = 'Measurements';
      for (const i of m.items) og.append(new Option(`${i.name} · ${KINDS[i.kind].label}`, `i${i.id}`));
      select.append(og);
    }
    const og = document.createElement('optgroup');
    og.label = 'Whole image';
    for (const [v, label] of Object.entries(GLOBALS)) og.append(new Option(label, v));
    select.append(og);
    select.value = value;
  }

  const refOf = (v) => (v in GLOBALS ? v : m.items.find((i) => `i${i.id}` === v));
  const needsMetric = (v) => { const r = refOf(v); return typeof r === 'object' && r.kind !== 'point'; };
  const source = (s, ms) => ({ ref: refOf(s.value), metric: needsMetric(s.value) ? ms.value : 'avg' });

  function syncDialog() {
    sel.am.hidden = !needsMetric(sel.a.value);
    sel.bm.hidden = !needsMetric(sel.b.value);
    const a = source(sel.a, sel.am), b = source(sel.b, sel.bm);
    $('diff-add').disabled = a.ref === b.ref && a.metric === b.metric;
  }
  for (const s of Object.values(sel)) s.onchange = syncDialog;

  function openDiffDialog() {
    arm(null);
    const ids = m.items.map((i) => `i${i.id}`);
    const a = ids[0] ?? 'center';
    fillSources(sel.a, a);
    fillSources(sel.b, ids[1] ?? (a === 'center' ? 'max' : 'center'));
    sel.am.value = sel.bm.value = 'max';
    syncDialog();
    dlg.showModal();
  }

  $('diff-form').addEventListener('submit', (e) => {
    e.preventDefault();
    m.addDiff(source(sel.a, sel.am), source(sel.b, sel.bm));
    dlg.close();
  });
  $('diff-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  renderSheet();

  return {
    /** Call after every view.draw(). */
    update() { renderOverlay(); updateValues(); },
    removeSelected() { if (m.selected) { m.remove(m.selected); return true; } return false; },
    cancel() {
      if (armed) arm(null);
      else if (m.selected) m.select(null);
    },
  };
}
