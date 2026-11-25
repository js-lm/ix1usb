// Draws thermal frames onto a <canvas>: palette, rotation/mirroring, and overlays.
//
// To add something drawn on top of the image (spot meters, regions, isotherms...), write a function
// `(ctx, image, view) => void` and push it onto `view.overlays`. `image` is the oriented
// TempImage being shown; use `view.toCanvas(x, y)` to turn image pixels into canvas pixels.

import { TempImage } from './ix1.js';
import { PALETTES } from './palettes.js';

const MIN_SPAN = 0.5; // °C; stops sensor noise filling the whole palette in a flat scene

/** Rotate (quarter turns clockwise) and/or mirror a TempImage. */
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
    this.palette = 0;   // index into PALETTES
    this.rotation = 0;  // quarter turns clockwise
    this.mirror = false;
    this.probe = null;  // {x, y} in image pixels, or null
    this.image = null;  // the oriented TempImage last drawn
    this.overlays = [drawMinMax, drawCenter, drawProbe];
    this._small = document.createElement('canvas'); // image at sensor resolution
  }

  get paletteName() { return PALETTES[this.palette].name; }
  nextPalette() { this.palette = (this.palette + 1) % PALETTES.length; }
  rotate() { this.rotation = (this.rotation + 1) % 4; this.probe = null; }
  toggleMirror() { this.mirror = !this.mirror; this.probe = null; }

  /** Canvas pixels per image pixel. */
  get scale() { return this.image ? this.canvas.width / this.image.width : 1; }
  /** Centre of image pixel (x, y) in canvas pixels. */
  toCanvas(x, y) { return [(x + 0.5) * this.scale, (y + 0.5) * this.scale]; }

  /** Image pixel under a pointer event, or null if outside. */
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

  /** Largest size that fits the parent's width and 75% of the window height; the backing store
   *  matches the on-screen size so overlays stay sharp on high-DPI screens. */
  _fitCanvas(img) {
    const c = this.canvas;
    const maxW = c.parentElement.clientWidth || img.width * 4;
    const maxH = window.innerHeight * 0.75;
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

// ---- overlays ----

const fmt = (t) => `${t.toFixed(1)}°C`;

/** White text on a translucent dark box, placed to stay inside the canvas. */
export function label(ctx, text, x, y, view) {
  const fs = Math.max(11, Math.round(13 * devicePixelRatio));
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const pad = fs * 0.3;
  const w = ctx.measureText(text).width + pad * 2;
  const h = fs + pad * 2;
  const bx = Math.min(Math.max(x, 0), view.canvas.width - w);
  const by = Math.min(Math.max(y - h, 0), view.canvas.height - h);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + pad, by + h / 2);
}

export function marker(ctx, cx, cy, color, shape = 'x') {
  const r = 7 * devicePixelRatio;
  ctx.lineCap = 'round';
  for (const [style, extra] of [['rgba(0,0,0,0.7)', 2 * devicePixelRatio], [color, 0]]) {
    ctx.strokeStyle = style;
    ctx.lineWidth = 2 * devicePixelRatio + extra;
    ctx.beginPath();
    if (shape === 'x') {
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
    } else {
      ctx.moveTo(cx - r * 1.3, cy); ctx.lineTo(cx + r * 1.3, cy);
      ctx.moveTo(cx, cy - r * 1.3); ctx.lineTo(cx, cy + r * 1.3);
    }
    ctx.stroke();
  }
}

function pointMarker(ctx, img, view, index, color) {
  const x = index % img.width, y = Math.floor(index / img.width);
  const [cx, cy] = view.toCanvas(x, y);
  marker(ctx, cx, cy, color);
  label(ctx, fmt(img.temp[index]), cx + 10 * devicePixelRatio, cy - 6 * devicePixelRatio, view);
}

export function drawMinMax(ctx, img, view) {
  pointMarker(ctx, img, view, img.maxIndex, '#ff4040');
  pointMarker(ctx, img, view, img.minIndex, '#40a0ff');
}

export function drawCenter(ctx, img, view) {
  const [cx, cy] = view.toCanvas(img.width >> 1, img.height >> 1);
  marker(ctx, cx, cy, '#fff', '+');
}

export function drawProbe(ctx, img, view) {
  if (!view.probe) return;
  const { x, y } = view.probe;
  pointMarker(ctx, img, view, y * img.width + x, '#40ff60');
}
