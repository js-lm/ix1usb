import { TempImage } from './ix1.js';
import { PALETTES, DEFAULT_PALETTE } from './palettes.js';
import { Measurements, drawItems, drawDiffs } from './measure.js';
import { drawVisible, DetailLayer, ImixLayer } from './visible.js';

const MIN_SPAN = 0.5; // °C; stops sensor noise filling the whole palette in a flat scene
const SIDE_GAP = 6; // CSS px between the two pictures in side-by-side

/** Saved photos and videos: the thermal picture's short side, whatever the window size. 768 gives a
 *  256×192 sensor 1024×768, the same size as the visible camera's picture. */
const CAPTURE_SHORT = 768;
const CAPTURE_GAP = 8; // px between the two pictures in side-by-side

/** Picture modes. Every mode but 'ir' needs the visible camera. */
export const MODES = {
  ir: 'IR',
  visible: 'Visible',
  pip: 'PIP',
  fusion: 'Fusion',
  imix: 'IMIX',
  side: 'Side by side',
  split: 'Slider',
};
export const needsVisible = (mode) => mode !== 'ir';

export function orient(img, rotation, mirror) {
  const { width: w, height: h, temp } = img;
  if (!rotation && !mirror) return img;
  const W = rotation % 2 ? h : w;
  const H = rotation % 2 ? w : h;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x0 = 0; x0 < w; x0++) {
      const x = mirror ? w - 1 - x0 : x0;
      let X, Y;
      switch (rotation) {
        case 1: X = h - 1 - y; Y = x; break;
        case 2: X = w - 1 - x; Y = h - 1 - y; break;
        case 3: X = y; Y = w - 1 - x; break;
        default: X = x; Y = y;
      }
      out[Y * W + X] = temp[y * w + x0];
    }
  }
  return new TempImage(out, W, H);
}

export class ThermalView {
  constructor(canvas, box = canvas.parentElement) {
    this.canvas = canvas;
    this.box = box;
    this.ctx = canvas.getContext('2d');
    this.palette = DEFAULT_PALETTE;
    /** 0–100, 50 = unchanged. Brightness slides the picture along the palette; contrast stretches it. */
    this.brightness = 50;
    this.contrast = 50;
    this.rotation = 1;
    this.mirror = false;
    this.showMax = true;
    this.showMin = true;
    this.showCenter = true;
    this.probe = null;
    this.image = null;
    this.srcW = 0;
    this.srcH = 0;
    this.measure = new Measurements();
    this.overlays = [drawItems, drawMinMax, drawCenter, drawProbe, drawDiffs];
    this._small = document.createElement('canvas');
    /** While drawing a saved photo or video frame: { unit, dpr } for that picture, else null. */
    this._capture = null;

    this.mode = 'ir';
    /** VisibleSource, or null. */
    this.vis = null;
    /** Fusion: how much of the thermal picture shows through (0–1). */
    this.blend = 0.5;
    /** IMIX: how much of the visible picture's texture shows in the thermal one (0–1). */
    this.imix = 0.5;
    /** Outlines from the visible picture drawn onto the thermal one, and their strength (0–100). */
    this.detail = false;
    this.detailLevel = 50;
    /** Picture-in-picture box, as fractions of the thermal frame; swap puts the visible picture behind. */
    this.pip = { x: 0.58, y: 0.03, w: 0.39, swap: false };
    /** Slider position across the frame (0–1): visible to its left, thermal to its right. */
    this.split = 0.5;
    /** While lining up the two cameras, show them blended whatever the mode. */
    this.aligning = false;
    /** Canvas-pixel rectangles [x, y, w, h]. The thermal picture always starts at the top-left corner,
     *  so overlays and pointer maths only need view.scale; `alt` is the second pane in side-by-side. */
    this.layout = { ir: [0, 0, 0, 0], alt: null, pip: null, size: [0, 0] };
    this._detail = new DetailLayer();
    this._imix = new ImixLayer();
    // Saved pictures get their own layers: they work at a different size from the screen, and sharing
    // would rebuild both every frame.
    this._captureLayers = { _detail: new DetailLayer(), _imix: new ImixLayer() };
  }

  get irW() { return this.layout.ir[2] || this.canvas.width; }
  get irH() { return this.layout.ir[3] || this.canvas.height; }
  get shownMode() { return this.aligning ? 'fusion' : this.mode; }

  get paletteName() { return PALETTES[this.palette].name; }
  nextPalette() { this.palette = (this.palette + 1) % PALETTES.length; }
  rotate() { this.rotation = (this.rotation + 1) % 4; this.probe = null; }
  toggleMirror() { this.mirror = !this.mirror; this.rotation = (4 - this.rotation) % 4; this.probe = null; }
  flipVertical() { this.mirror = !this.mirror; this.rotation = (6 - this.rotation) % 4; this.probe = null; }

  /** Size the markers and their text are drawn at. On screen it's kept between 12 and 22 CSS px, so it
   *  stays readable in a small window and doesn't grow huge in a big one; in a saved picture it's a fixed
   *  share of the picture, since nobody knows what size it'll be looked at. */
  get unit() {
    if (this._capture) return this._capture.unit;
    const dpr = devicePixelRatio;
    return Math.min(Math.max(this.irW / 28, 12 * dpr), 22 * dpr);
  }
  /** Canvas pixels per CSS pixel, for line widths and shadows; in a saved picture it follows unit. */
  get dpr() { return this._capture ? this._capture.dpr : devicePixelRatio; }
  /** True while drawing a saved photo or video frame. */
  get capturing() { return !!this._capture; }

  /** Canvas pixels per image pixel. */
  get scale() { return this.image ? this.irW / this.image.width : 1; }
  toCanvas(x, y) { return [(x + 0.5) * this.scale, (y + 0.5) * this.scale]; }
  /** CSS pixels per canvas pixel. */
  get cssPerPx() { return this.canvas.width ? this.canvas.clientWidth / this.canvas.width : 1; }
  /** CSS pixels per image pixel. */
  get cssScale() { return this.scale * this.cssPerPx; }

  // Continuous sensor coordinates <-> continuous displayed-image coordinates, matching orient().
  toDisplay([x, y]) {
    const w = this.srcW, h = this.srcH;
    if (this.mirror) x = w - x;
    switch (this.rotation) {
      case 1: return [h - y, x];
      case 2: return [w - x, h - y];
      case 3: return [y, w - x];
      default: return [x, y];
    }
  }
  toSensor([X, Y]) {
    const w = this.srcW, h = this.srcH;
    let x, y;
    switch (this.rotation) {
      case 1: x = Y; y = h - X; break;
      case 2: x = w - X; y = h - Y; break;
      case 3: x = w - Y; y = X; break;
      default: x = X; y = Y;
    }
    return [this.mirror ? w - x : x, y];
  }

  /** Continuous displayed-image coordinates under the pointer, clamped to the image. */
  imageCoordAt(event) {
    const [cx, cy] = this.canvasPointAt(event);
    const { width: W, height: H } = this.image;
    const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
    return [clamp(cx / this.scale, W), clamp(cy / this.scale, H)];
  }

  /** Pointer position in canvas backing-store pixels. */
  canvasPointAt(event) {
    const r = this.canvas.getBoundingClientRect();
    return [((event.clientX - r.left) / r.width) * this.canvas.width, ((event.clientY - r.top) / r.height) * this.canvas.height];
  }

  imagePointAt(event) {
    if (!this.image) return null;
    const [cx, cy] = this.canvasPointAt(event);
    const x = Math.floor(cx / this.scale), y = Math.floor(cy / this.scale);
    if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height) return null;
    return { x, y };
  }

  /** The picture-in-picture box in canvas pixels, kept inside the frame. */
  pipRect() {
    const [x, y, w, h] = this.layout.ir;
    const p = this.pip;
    p.w = Math.min(Math.max(p.w, 0.15), 0.9);
    p.x = Math.min(Math.max(p.x, 0), 1 - p.w);
    p.y = Math.min(Math.max(p.y, 0), 1 - p.w);
    return [x + p.x * w, y + p.y * h, p.w * w, p.w * h];
  }

  /** Orients and colours a frame, ready to draw. */
  _prepare(frame) {
    const img = orient(frame, this.rotation, this.mirror);
    this.image = img;
    this.srcW = frame.width;
    this.srcH = frame.height;
    this._colorize(img);
    return img;
  }

  /** Draws a frame on screen. */
  draw(frame) {
    const img = this._prepare(frame);
    this._fitCanvas(img);
    this._render(img, true);
  }

  /** Size [w, h] of a saved photo or video frame of `img` (as displayed, i.e. already turned) in the
   *  current mode: the thermal picture at CAPTURE_SHORT px on its short side, and in side-by-side the
   *  visible one next to it. Both even, as video encoders need. */
  captureSize(img = this.image) {
    const { width: w, height: h } = img;
    const k = CAPTURE_SHORT / Math.min(w, h);
    const even = (v) => 2 * Math.round(v / 2);
    const pw = even(w * k), ph = even(h * k);
    return this.shownMode === 'side' ? [2 * pw + CAPTURE_GAP, ph] : [pw, ph];
  }

  /** Draws a frame for a saved photo or video onto `canvas`, independent of the screen. `size` fixes the
   *  canvas size (a video can't change size part way); if the picture's shape doesn't match, as after
   *  rotating mid-recording, it's fitted inside with black bars. `markers` draws the readings and
   *  measurements. The screen's own state (hit areas, layout) is left as it was. */
  drawCapture(frame, canvas, { size = null, markers = true } = {}) {
    const img = this._prepare(frame);
    const natural = this.captureSize(img);
    const [W, H] = size ?? natural;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const s = Math.min(W / natural[0], H / natural[1]);
    const side = this.shownMode === 'side';
    const gap = side ? Math.round(CAPTURE_GAP * s) : 0;
    const pw = Math.floor(((side ? (natural[0] - CAPTURE_GAP) / 2 : natural[0])) * s);
    const ph = Math.floor(natural[1] * s);
    const cw = side ? 2 * pw + gap : pw;
    const ox = Math.floor((W - cw) / 2), oy = Math.floor((H - ph) / 2);
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(ox, oy);
    // Text at a fixed share of the picture: short side / 28, so the smallest labels (0.75 of it) stay
    // above 20 px at 768 and survive video compression. Line widths follow, as if on a screen where
    // that text would be 18 CSS px.
    const unit = Math.min(pw, ph) / 28;
    const target = {
      ctx,
      layout: { ir: [0, 0, pw, ph], alt: side ? [pw + gap, 0, pw, ph] : null, pip: null, size: [cw, ph] },
      _capture: { unit, dpr: unit / 18 },
      ...this._captureLayers,
    };
    const keys = Object.keys(target);
    const saved = keys.map((key) => this[key]);
    Object.assign(this, target);
    try {
      this._render(img, markers);
    } finally {
      keys.forEach((key, i) => { this[key] = saved[i]; });
      ctx.restore();
    }
    return canvas;
  }

  /** Draws the picture, and the markers if `markers`, onto this.ctx using this.layout. */
  _render(img, markers) {
    const { ctx, vis } = this;
    const ir = this.layout.ir;
    const mode = this.shownMode;
    const dpr = this.dpr;
    // The detail layer always covers the whole thermal frame, so it scales into a PIP box too.
    let layer;
    const detailLayer = () => (layer ??= (vis && this._detail.build(vis, this, ir[2], ir[3], this.detailLevel / 100)) || null);
    const thermal = (rect, alpha = 1) => {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalAlpha = alpha;
      ctx.drawImage(this._small, ...rect);
      ctx.globalAlpha = 1;
      if (this.detail && alpha === 1 && detailLayer()) {
        ctx.globalCompositeOperation = 'overlay';
        ctx.drawImage(layer, ...rect);
        ctx.globalCompositeOperation = 'source-over';
      }
    };
    const visible = (rect, clip = rect) => (vis && drawVisible(ctx, vis, this, rect, clip)) || this._noVisible(clip);
    const ready = !!vis?.ready;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ...this.layout.size);
    this.layout.pip = null;
    switch (mode) {
      case 'visible':
        visible(ir);
        break;
      case 'fusion':
        if (ready) visible(ir);
        thermal(ir, ready ? (this.aligning ? 0.5 : this.blend) : 1);
        break;
      case 'imix': {
        const mixed = vis && this._imix.build(vis, this, this._small, ir[2], ir[3], this.imix);
        if (mixed) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(mixed, ...ir);
        } else thermal(ir);
        break;
      }
      case 'side':
        thermal(ir);
        visible(this.layout.alt);
        break;
      case 'split': {
        thermal(ir);
        const sx = Math.round(ir[2] * this.split);
        if (sx > 0) visible(ir, [ir[0], ir[1], sx, ir[3]]);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(ir[0] + sx - dpr, ir[1], 2 * dpr, ir[3]);
        break;
      }
      case 'pip':
        if (this.pip.swap) visible(ir);
        else thermal(ir);
        break;
      default:
        thermal(ir);
    }
    if (markers) for (const overlay of this.overlays) overlay(ctx, img, this);
    if (mode === 'pip') {
      const r = (this.layout.pip = this.pipRect());
      ctx.fillStyle = '#000';
      ctx.fillRect(...r);
      if (this.pip.swap) thermal(r);
      else visible(r);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(r[0], r[1], r[2], r[3]);
    }
  }

  /** Placeholder where the visible picture would go. */
  _noVisible(rect) {
    const { ctx } = this;
    const [x, y, w, h] = rect;
    ctx.save();
    ctx.fillStyle = '#1c1c1e';
    ctx.fillRect(x, y, w, h);
    const fs = Math.round(Math.min(this.unit * 0.8, w / 9));
    if (fs >= 6) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = '#9a9aa0';
      ctx.font = `500 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = this.vis?.error ? 'No visible image' : 'Waiting for camera…';
      ctx.fillText(text, x + w / 2, y + h / 2, w - fs);
    }
    ctx.restore();
    return false;
  }

  _colorize(img) {
    const { width: w, height: h, temp } = img;
    const lut = PALETTES[this.palette].lut;
    const lo = img.min;
    // Palette index = (t - mid) * contrast + mid + brightness, with contrast from ×¼ to ×4.
    const c = 2 ** ((this.contrast - 50) / 25);
    const k = (255 / Math.max(img.max - lo, MIN_SPAN)) * c;
    const off = 127.5 * (1 - c) + (this.brightness - 50) * 2.55;
    const small = this._small;
    if (small.width !== w || small.height !== h) {
      small.width = w;
      small.height = h;
      this._pixels = null;
    }
    const sctx = small.getContext('2d');
    this._pixels ??= sctx.createImageData(w, h);
    const px = this._pixels.data;
    for (let i = 0; i < temp.length; i++) {
      const v = Math.max(0, Math.min(255, ((temp[i] - lo) * k + off) | 0)) * 3;
      px[i * 4] = lut[v];
      px[i * 4 + 1] = lut[v + 1];
      px[i * 4 + 2] = lut[v + 2];
      px[i * 4 + 3] = 255;
    }
    sctx.putImageData(this._pixels, 0, 0);
  }

  /** Largest size that fits the parent element; the backing store matches the on-screen size so
   *  overlays stay sharp on high-DPI screens. Side-by-side puts the two pictures next to each other or
   *  one above the other, whichever shows them bigger. */
  _fitCanvas(img) {
    const c = this.canvas;
    const dpr = devicePixelRatio;
    const maxW = this.box.clientWidth || img.width * 4;
    const maxH = this.box.clientHeight || img.height * 4;
    const iw = img.width, ih = img.height;
    let across = 1, down = 1;
    if (this.shownMode === 'side') {
      const sAcross = Math.min((maxW - SIDE_GAP) / (2 * iw), maxH / ih);
      const sDown = Math.min(maxW / iw, (maxH - SIDE_GAP) / (2 * ih));
      if (sAcross >= sDown) across = 2;
      else down = 2;
    }
    const gapW = across > 1 ? SIDE_GAP : 0, gapH = down > 1 ? SIDE_GAP : 0;
    const s = Math.min((maxW - gapW) / (across * iw), (maxH - gapH) / (down * ih));
    const paneW = Math.floor(iw * s), paneH = Math.floor(ih * s);
    const cssW = paneW * across + gapW, cssH = paneH * down + gapH;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const pw = Math.round(paneW * dpr), ph = Math.round(paneH * dpr);
    this.layout.ir = [0, 0, pw, ph];
    this.layout.alt = across > 1 ? [w - pw, 0, pw, ph] : down > 1 ? [0, h - ph, pw, ph] : null;
    this.layout.size = [w, h];
  }
}

const fmt = (t) => `${t.toFixed(1)}°C`;

const markerSize = (view) => ({ h: view.unit * 0.22, arm: view.unit * 0.6 });

export function marker(ctx, cx, cy, color, view) {
  const { h, arm } = markerSize(view);
  const lw = Math.max(1.5, view.unit * 0.09);
  ctx.lineCap = 'butt';
  for (const [style, width] of [['rgba(0,0,0,0.55)', lw + 2 * view.dpr], [color, lw]]) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(cx - h - arm, cy); ctx.lineTo(cx - h, cy);
    ctx.moveTo(cx + h, cy); ctx.lineTo(cx + h + arm, cy);
    ctx.moveTo(cx, cy - h - arm); ctx.lineTo(cx, cy - h);
    ctx.moveTo(cx, cy + h); ctx.lineTo(cx, cy + h + arm);
    ctx.rect(cx - h, cy - h, h * 2, h * 2);
    ctx.stroke();
  }
}

export function label(ctx, text, cx, cy, view) {
  const { h, arm } = markerSize(view);
  const fs = Math.round(view.unit);
  ctx.font = `500 ${fs}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  const gap = h + arm + fs * 0.3;
  let x = cx + gap;
  if (x + w > view.irW) x = cx - gap - w;
  const y = Math.min(Math.max(cy, fs * 0.6), view.irH - fs * 0.6);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 3 * view.dpr;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, Math.max(0, x), y);
  ctx.restore();
}

function pointMarker(ctx, img, view, index, color) {
  const x = index % img.width, y = Math.floor(index / img.width);
  const [cx, cy] = view.toCanvas(x, y);
  marker(ctx, cx, cy, color, view);
  label(ctx, fmt(img.temp[index]), cx, cy, view);
}

export function drawMinMax(ctx, img, view) {
  if (view.showMax) pointMarker(ctx, img, view, img.maxIndex, '#ff3b30');
  if (view.showMin) pointMarker(ctx, img, view, img.minIndex, '#2f7bff');
}

export function drawCenter(ctx, img, view) {
  if (!view.showCenter) return;
  pointMarker(ctx, img, view, (img.height >> 1) * img.width + (img.width >> 1), '#fff');
}

export function drawProbe(ctx, img, view) {
  if (!view.probe) return;
  const { x, y } = view.probe;
  pointMarker(ctx, img, view, y * img.width + x, '#34e36b');
}
