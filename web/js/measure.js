// User-placed measurements (points, lines, frames, circles) and temperature-difference rules.
// Geometry is stored in sensor coordinates so items stay on the same spot in the scene when the
// view is rotated or flipped; everything else here works in displayed-image coordinates.

export const KINDS = {
  point: { prefix: 'P', label: 'Point' },
  line: { prefix: 'L', label: 'Line' },
  rect: { prefix: 'R', label: 'Frame' },
  circle: { prefix: 'C', label: 'Circle' },
};
export const GLOBALS = { center: 'Center', max: 'Hottest', min: 'Coldest' };
export const METRICS = { max: 'Max', min: 'Min', avg: 'Avg' };

const HOT = '#ff3b30';
const COLD = '#2f7bff';

let nextId = 1;

export class Measurements {
  constructor() {
    this.items = [];
    this.diffs = [];
    this.selected = null;
    this.onchange = null;
  }

  get empty() { return !this.items.length && !this.diffs.length; }

  _name(prefix, list) {
    let n = 1;
    while (list.some((o) => o.name === prefix + n)) n++;
    return prefix + n;
  }

  add(kind, geom) {
    const item = { id: nextId++, kind, name: this._name(KINDS[kind].prefix, this.items), ...geom, stats: null };
    this.items.push(item);
    this.select(item);
    return item;
  }

  /** a and b are sources: { ref: item | 'center' | 'max' | 'min', metric: 'max' | 'min' | 'avg' }. */
  addDiff(a, b) {
    const d = { id: nextId++, kind: 'diff', name: this._name('D', this.diffs), a, b, value: NaN, box: null };
    this.diffs.push(d);
    this.select(d);
    return d;
  }

  /** Removing an item also removes the difference rules that use it. */
  remove(obj) {
    if (obj.kind === 'diff') {
      this.diffs = this.diffs.filter((d) => d !== obj);
    } else {
      this.items = this.items.filter((i) => i !== obj);
      this.diffs = this.diffs.filter((d) => d.a.ref !== obj && d.b.ref !== obj);
    }
    if (this.selected && !this.items.includes(this.selected) && !this.diffs.includes(this.selected)) this.selected = null;
    this.changed();
  }

  clear() {
    this.items = [];
    this.diffs = [];
    this.selected = null;
    this.changed();
  }

  select(obj) {
    this.selected = obj;
    this.changed();
  }

  changed() { this.onchange?.(); }
}

export function sourceLabel(s) {
  if (typeof s.ref === 'string') return GLOBALS[s.ref];
  return s.ref.kind === 'point' ? s.ref.name : `${s.ref.name} ${METRICS[s.metric]}`;
}

export const diffLabel = (d) => `${sourceLabel(d.a)} − ${sourceLabel(d.b)}`;

export function sourceValue(s, img) {
  if (s.ref === 'center') return img.tempAt(img.width >> 1, img.height >> 1);
  if (s.ref === 'max') return img.max;
  if (s.ref === 'min') return img.min;
  const st = s.ref.stats;
  if (!st) return NaN;
  return s.ref.kind === 'point' ? st.avg : st[s.metric];
}

export const fmtDelta = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}°C` : '–');

// ---- geometry (displayed-image coordinates) ----

/** { box: [x0, y0, x1, y1], handles: [[x, y], ...], plus shape-specific fields }. */
export function geometry(item, view) {
  const D = (p) => view.toDisplay(p);
  switch (item.kind) {
    case 'point': {
      const p = D(item.p);
      return { p, box: [p[0], p[1], p[0], p[1]], handles: [] };
    }
    case 'line': {
      const a = D(item.a), b = D(item.b);
      return { a, b, box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], handles: [a, b] };
    }
    case 'rect': {
      const a = D(item.a), b = D(item.b);
      const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
      return { box: [x0, y0, x1, y1], handles: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    }
    case 'circle': {
      const [cx, cy] = D(item.c), r = item.r;
      return { c: [cx, cy], r, box: [cx - r, cy - r, cx + r, cy + r], handles: [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]] };
    }
  }
}

/** Writes displayed-image geometry back to the item (in sensor coordinates). */
export function setGeometry(item, g, view) {
  const S = (p) => view.toSensor(p);
  switch (item.kind) {
    case 'point': item.p = S(g.p); break;
    case 'line': item.a = S(g.a); item.b = S(g.b); break;
    case 'rect': item.a = S([g.box[0], g.box[1]]); item.b = S([g.box[2], g.box[3]]); break;
    case 'circle': item.c = S(g.c); item.r = g.r; break;
  }
}

export function translate(g, dx, dy) {
  const t = (p) => [p[0] + dx, p[1] + dy];
  const box = [g.box[0] + dx, g.box[1] + dy, g.box[2] + dx, g.box[3] + dy];
  return { ...g, box, p: g.p && t(g.p), a: g.a && t(g.a), b: g.b && t(g.b), c: g.c && t(g.c) };
}

// ---- statistics ----

function pixelIndex(img, x, y) {
  const ix = Math.min(Math.max(Math.floor(x), 0), img.width - 1);
  const iy = Math.min(Math.max(Math.floor(y), 0), img.height - 1);
  return iy * img.width + ix;
}

/** { max, min, avg, maxIdx, minIdx } over the pixels the item covers. */
export function computeStats(item, g, img) {
  const { temp, width: W, height: H } = img;
  let max = -Infinity, min = Infinity, sum = 0, n = 0, maxIdx = 0, minIdx = 0;
  const add = (i) => {
    const t = temp[i];
    sum += t;
    n++;
    if (t > max) { max = t; maxIdx = i; }
    if (t < min) { min = t; minIdx = i; }
  };
  if (item.kind === 'point') {
    add(pixelIndex(img, ...g.p));
  } else if (item.kind === 'line') {
    const [ax, ay] = g.a, [bx, by] = g.b;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    let last = -1;
    for (let k = 0; k <= steps; k++) {
      const i = pixelIndex(img, ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
      if (i !== last) add(i);
      last = i;
    }
  } else {
    const [x0, y0, x1, y1] = g.box;
    const ix0 = Math.max(0, Math.ceil(x0 - 0.5)), ix1 = Math.min(W - 1, Math.floor(x1 - 0.5));
    const iy0 = Math.max(0, Math.ceil(y0 - 0.5)), iy1 = Math.min(H - 1, Math.floor(y1 - 0.5));
    const circle = item.kind === 'circle';
    const r2 = g.r * g.r;
    for (let y = iy0; y <= iy1; y++) {
      for (let x = ix0; x <= ix1; x++) {
        if (circle && (x + 0.5 - g.c[0]) ** 2 + (y + 0.5 - g.c[1]) ** 2 > r2) continue;
        add(y * W + x);
      }
    }
    if (!n) add(pixelIndex(img, (x0 + x1) / 2, (y0 + y1) / 2));
  }
  return { max, min, avg: sum / n, maxIdx, minIdx };
}

// ---- hit testing ----

function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const inBox = ([x, y], b, pad = 0) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;

/** pos: displayed-image coords; cpos: canvas pixels; tol: image pixels. Returns { obj, handle } or null. */
export function hitTest(m, view, pos, cpos, tol) {
  const sel = m.selected;
  if (sel && sel.kind !== 'diff') {
    const g = geometry(sel, view);
    const h = g.handles.findIndex((p) => Math.hypot(p[0] - pos[0], p[1] - pos[1]) <= tol * 1.3);
    if (h >= 0) return { obj: sel, handle: h };
  }
  for (const d of m.diffs) if (d.box && inBox(cpos, d.box)) return { obj: d, handle: -1 };
  // Selected item wins, then the most recently added.
  const order = sel && sel.kind !== 'diff' ? [sel, ...m.items.filter((i) => i !== sel).reverse()] : [...m.items].reverse();
  for (const item of order) {
    const g = geometry(item, view);
    let hit = item.labelBox && inBox(cpos, item.labelBox);
    switch (item.kind) {
      case 'point': hit ||= Math.hypot(g.p[0] - pos[0], g.p[1] - pos[1]) <= tol * 1.5; break;
      case 'line': hit ||= distToSegment(pos, g.a, g.b) <= tol; break;
      case 'rect': hit ||= inBox(pos, g.box, tol); break;
      case 'circle': hit ||= Math.hypot(g.c[0] - pos[0], g.c[1] - pos[1]) <= g.r + tol; break;
    }
    if (hit) return { obj: item, handle: -1 };
  }
  return null;
}

// ---- drawing (canvas overlays, so they appear in photos and recordings) ----

const lineWidth = (view) => Math.max(1.25 * devicePixelRatio, view.unit * 0.07);

function strokeOutlined(ctx, view, build) {
  const lw = lineWidth(view);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [style, width] of [['rgba(0,0,0,0.5)', lw + 2 * devicePixelRatio], ['#fff', lw]]) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    build();
    ctx.stroke();
  }
}

function triangle(ctx, x, y, size, up, color) {
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y + size * 0.75); ctx.lineTo(x - size, y + size * 0.75); }
  else { ctx.moveTo(x, y + size); ctx.lineTo(x + size, y - size * 0.75); ctx.lineTo(x - size, y - size * 0.75); }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = devicePixelRatio;
  ctx.fill();
  ctx.stroke();
}

/** lines: arrays of segments, each a string or { tri: 'up' | 'down' }. Returns the drawn box. */
function textBlock(ctx, view, lines, place) {
  const fs = Math.round(view.unit * 0.8);
  const lh = Math.round(fs * 1.2);
  const tri = fs * 0.32;
  ctx.font = `500 ${fs}px system-ui, sans-serif`;
  const segW = (s) => (typeof s === 'string' ? ctx.measureText(s).width : tri * 2 + fs * 0.15);
  const w = Math.max(...lines.map((l) => l.reduce((a, s) => a + segW(s), 0)));
  const h = lines.length * lh;
  let [x, y] = place(w, h);
  x = Math.min(Math.max(x, 0), view.irW - w);
  y = Math.min(Math.max(y, 0), view.irH - h);
  ctx.save();
  ctx.textBaseline = 'middle';
  lines.forEach((line, row) => {
    let cx = x;
    const cy = y + row * lh + lh / 2;
    for (const s of line) {
      if (typeof s === 'string') {
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 3 * devicePixelRatio;
        ctx.fillStyle = '#fff';
        ctx.fillText(s, cx, cy);
        ctx.shadowBlur = 0;
      } else {
        triangle(ctx, cx + tri, cy, tri, s.tri === 'up', s.tri === 'up' ? HOT : COLD);
      }
      cx += segW(s);
    }
  });
  ctx.restore();
  return [x, y, x + w, y + h];
}

const f1 = (t) => t.toFixed(1);

function drawItem(ctx, img, view, item) {
  const s = view.scale;
  const g = item.g;
  const st = item.stats;
  const C = (p) => [p[0] * s, p[1] * s];
  if (item.kind === 'point') {
    const [cx, cy] = C(g.p);
    const arm = view.unit * 0.55;
    strokeOutlined(ctx, view, () => {
      ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
      ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
    });
    const gap = arm * 0.5;
    item.labelBox = textBlock(ctx, view, [[item.name], [`${f1(st.avg)}°C`]], (w, h) => {
      const x = cx + gap + w > view.irW ? cx - gap - w : cx + gap;
      const y = cy - gap - h < 0 ? cy + gap : cy - gap - h;
      return [x, y];
    });
    return;
  }
  strokeOutlined(ctx, view, () => {
    if (item.kind === 'line') { ctx.moveTo(...C(g.a)); ctx.lineTo(...C(g.b)); }
    else if (item.kind === 'rect') { const [x0, y0] = C(g.box), [x1, y1] = C(g.box.slice(2)); ctx.rect(x0, y0, x1 - x0, y1 - y0); }
    else { const [cx, cy] = C(g.c); ctx.arc(cx, cy, g.r * s, 0, Math.PI * 2); }
  });
  const tri = view.unit * 0.3;
  const at = (i) => view.toCanvas(i % img.width, Math.floor(i / img.width));
  if (st.maxIdx !== st.minIdx) triangle(ctx, ...at(st.minIdx), tri, false, COLD);
  triangle(ctx, ...at(st.maxIdx), tri, true, HOT);

  const [bx0, by0] = C(g.box), [, by1] = C(g.box.slice(2));
  const pad = view.unit * 0.3;
  item.labelBox = textBlock(ctx, view, [[item.name], [{ tri: 'up' }, `${f1(st.max)} `, { tri: 'down' }, `${f1(st.min)}  avg ${f1(st.avg)}°C`]], (w, h) => {
    if (by0 - pad - h >= 0) return [bx0, by0 - pad - h];
    if (by1 + pad + h <= view.irH) return [bx0, by1 + pad];
    return [bx0 + pad, by0 + pad];
  });
}

export function drawItems(ctx, img, view) {
  for (const item of view.measure.items) {
    item.g = geometry(item, view);
    item.stats = computeStats(item, item.g, img);
  }
  for (const item of view.measure.items) drawItem(ctx, img, view, item);
}

export function drawDiffs(ctx, img, view) {
  const diffs = view.measure.diffs;
  if (!diffs.length) return;
  const fs = Math.round(view.unit * 0.75);
  const lh = Math.round(fs * 1.5);
  const pad = Math.round(fs * 0.6);
  ctx.font = `500 ${fs}px system-ui, sans-serif`;
  const rows = diffs.map((d) => {
    d.value = sourceValue(d.a, img) - sourceValue(d.b, img);
    return `${diffLabel(d)}: ${fmtDelta(d.value)}`;
  });
  const w = Math.min(Math.max(...rows.map((r) => ctx.measureText(r).width)) + pad * 2, view.irW - pad * 2);
  const x = pad, y = pad;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, rows.length * lh + pad * 0.5, fs * 0.4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  rows.forEach((text, i) => {
    const ry = y + pad * 0.25 + i * lh;
    ctx.fillText(text, x + pad, ry + lh / 2, w - pad * 2);
    diffs[i].box = [x, ry, x + w, ry + lh];
  });
  ctx.restore();
}
