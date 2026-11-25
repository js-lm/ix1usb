import { TempImage } from './ix1.js';
import { PALETTES, DEFAULT_PALETTE } from './palettes.js';

const MIN_SPAN = 0.5; // °C; stops sensor noise filling the whole palette in a flat scene

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
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.palette = DEFAULT_PALETTE;
    this.rotation = 1;
    this.mirror = false;
    this.showMinMax = true;
    this.showCenter = true;
    this.probe = null;
    this.image = null;
    this.overlays = [drawMinMax, drawCenter, drawProbe];
    this._small = document.createElement('canvas');
  }

  get paletteName() { return PALETTES[this.palette].name; }
  nextPalette() { this.palette = (this.palette + 1) % PALETTES.length; }
  rotate() { this.rotation = (this.rotation + 1) % 4; this.probe = null; }
  toggleMirror() { this.mirror = !this.mirror; this.probe = null; }
  flipVertical() { this.mirror = !this.mirror; this.rotation = (this.rotation + 2) % 4; this.probe = null; }

  get unit() {
    const dpr = devicePixelRatio;
    return Math.min(Math.max(this.canvas.width / 28, 12 * dpr), 22 * dpr);
  }

  get scale() { return this.image ? this.canvas.width / this.image.width : 1; }
  toCanvas(x, y) { return [(x + 0.5) * this.scale, (y + 0.5) * this.scale]; }

  imagePointAt(event) {
    if (!this.image) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - r.left) / r.width) * this.image.width);
    const y = Math.floor(((event.clientY - r.top) / r.height) * this.image.height);
    if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height) return null;
    return { x, y };
  }

  draw(frame) {
    const img = orient(frame, this.rotation, this.mirror);
    this.image = img;
    this._colorize(img);
    this._fitCanvas(img);
    const { ctx, canvas } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._small, 0, 0, canvas.width, canvas.height);
    for (const overlay of this.overlays) overlay(ctx, img, this);
  }

  _colorize(img) {
    const { width: w, height: h, temp } = img;
    const small = this._small;
    if (small.width !== w || small.height !== h) {
      small.width = w;
      small.height = h;
      this._pixels = null;
    }
    const sctx = small.getContext('2d');
    this._pixels ??= sctx.createImageData(w, h);
    const px = this._pixels.data;
    const lut = PALETTES[this.palette].lut;
    const lo = img.min;
    const k = 255 / Math.max(img.max - lo, MIN_SPAN);
    for (let i = 0; i < temp.length; i++) {
      const v = Math.max(0, Math.min(255, ((temp[i] - lo) * k) | 0)) * 3;
      px[i * 4] = lut[v];
      px[i * 4 + 1] = lut[v + 1];
      px[i * 4 + 2] = lut[v + 2];
      px[i * 4 + 3] = 255;
    }
    sctx.putImageData(this._pixels, 0, 0);
  }

  /** Largest size that fits the parent element; the backing store matches the on-screen size so
   *  overlays stay sharp on high-DPI screens. */
  _fitCanvas(img) {
    const c = this.canvas;
    const maxW = c.parentElement.clientWidth || img.width * 4;
    const maxH = c.parentElement.clientHeight || img.height * 4;
    const s = Math.min(maxW / img.width, maxH / img.height);
    const cssW = Math.floor(img.width * s), cssH = Math.floor(img.height * s);
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    const w = Math.round(cssW * devicePixelRatio), h = Math.round(cssH * devicePixelRatio);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
}

const fmt = (t) => `${t.toFixed(1)}°C`;

const markerSize = (view) => ({ h: view.unit * 0.22, arm: view.unit * 0.6 });

export function marker(ctx, cx, cy, color, view) {
  const { h, arm } = markerSize(view);
  const lw = Math.max(1.5, view.unit * 0.09);
  ctx.lineCap = 'butt';
  for (const [style, width] of [['rgba(0,0,0,0.55)', lw + 2 * devicePixelRatio], [color, lw]]) {
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
  if (x + w > view.canvas.width) x = cx - gap - w;
  const y = Math.min(Math.max(cy, fs * 0.6), view.canvas.height - fs * 0.6);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 3 * devicePixelRatio;
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
  if (!view.showMinMax) return;
  pointMarker(ctx, img, view, img.maxIndex, '#ff3b30');
  pointMarker(ctx, img, view, img.minIndex, '#2f7bff');
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
