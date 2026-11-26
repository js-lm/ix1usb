// The visible-light picture: either the Go Pro's own camera (MJPEG over USB) or, for cameras without
// one, this phone's or computer's camera. Also the alignment between it and the thermal image.

const store = {
  get(key, fallback) {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key)) }; } catch { return { ...fallback }; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};
export { store };

/** s: zoom, x/y: offset as a fraction of the thermal frame, rot: extra quarter turns, flip: mirror. */
export const DEFAULT_ALIGN = { s: 1, x: 0, y: 0, rot: 0, flip: false };

export class VisibleSource {
  constructor() {
    /** 'builtin' (the camera's own) or 'device' (this phone's/computer's camera). */
    this.kind = 'device';
    this.image = null; // ImageBitmap or HTMLVideoElement
    this.frameId = 0;
    this.error = '';
    this.onframe = null;
    this.onerror = null;
    this._decoding = false;
    this._pending = null;
    this._stream = null;
    this._video = null;
    this._starting = null;
    this.align = { builtin: store.get('ix1.align.builtin', DEFAULT_ALIGN), device: store.get('ix1.align.device', DEFAULT_ALIGN) };
  }

  get cal() { return this.align[this.kind]; }
  saveAlign() { store.set(`ix1.align.${this.kind}`, this.cal); }
  resetAlign() { this.align[this.kind] = { ...DEFAULT_ALIGN }; this.saveAlign(); }

  get ready() {
    const im = this.image;
    if (!im) return false;
    return im instanceof HTMLVideoElement ? im.readyState >= 2 && im.videoWidth > 0 : true;
  }
  get width() { return this.image instanceof HTMLVideoElement ? this.image.videoWidth : this.image?.width ?? 0; }
  get height() { return this.image instanceof HTMLVideoElement ? this.image.videoHeight : this.image?.height ?? 0; }

  /** Feed a JPEG from the camera's own visible stream. Frames that arrive while one is decoding replace
   *  each other, so a slow device shows the newest frame rather than falling behind. */
  pushJPEG(bytes) {
    if (this.kind !== 'builtin') return;
    this._pending = bytes;
    if (!this._decoding) this._decode();
  }

  async _decode() {
    this._decoding = true;
    while (this._pending) {
      const bytes = this._pending;
      this._pending = null;
      try {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (this.kind !== 'builtin') { bmp.close(); break; }
        const old = this.image;
        this.image = bmp;
        this.frameId++;
        if (old && 'close' in old) old.close();
        this.onframe?.();
      } catch {
        // A damaged frame; the next one will do.
      }
    }
    this._decoding = false;
  }

  /** Switches between the camera's own visible stream ('builtin'), this device's camera ('device'),
   *  or nothing (null). */
  async use(kind) {
    if (kind === 'device') {
      this.kind = 'device';
      if (this._closeBitmap()) this.frameId++;
      return this._startDevice();
    }
    this._stopDevice();
    if (kind === 'builtin' && this.kind !== 'builtin') { this.kind = 'builtin'; this.image = null; }
    if (!kind) this._closeBitmap();
    this.error = '';
  }

  _closeBitmap() {
    const im = this.image;
    if (im && !(im instanceof HTMLVideoElement)) { im.close(); this.image = null; return true; }
    return false;
  }

  async _startDevice() {
    if (this._stream) return;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      this.error = '';
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser can't use the camera");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      if (this.kind !== 'device') { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = this._video ?? document.createElement('video');
      // Kept in the page (but invisible) so browsers don't pause it.
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      if (!v.isConnected) document.body.append(v);
      v.srcObject = stream;
      this._video = v;
      this._stream = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this._stream !== stream) return;
        this._stopDevice();
        this.error = 'the camera stopped';
        this.onerror?.(this.error);
      });
      v.onloadeddata = () => this.onframe?.();
      await v.play();
      this.image = v;
      this.frameId++;
    })();
    try {
      await this._starting;
    } catch (e) {
      this.error = e.name === 'NotAllowedError' ? 'camera access was blocked' : e.name === 'NotFoundError' ? 'no camera found' : e.message;
      throw new Error(this.error);
    } finally {
      this._starting = null;
    }
  }

  _stopDevice() {
    if (this._stream) this._stream.getTracks().forEach((t) => t.stop());
    this._stream = null;
    if (this._video) { this._video.srcObject = null; }
    if (this.image instanceof HTMLVideoElement) this.image = null;
  }
}

/** Draws the visible picture lined up with the thermal frame `rect` ([x, y, w, h] on the canvas).
 *  view supplies the thermal orientation: the camera's own visible sensor turns with it, while a
 *  phone's camera is already upright. */
export function drawVisible(ctx, vis, view, rect, clip = rect) {
  if (!vis.ready) return false;
  const cal = vis.cal;
  const [x, y, w, h] = rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(...clip);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  // Into the frame the alignment is stored in: sensor axes for the built-in camera, so it survives
  // rotating or flipping the view; screen axes for a phone camera.
  let fw = w, fh = h;
  if (vis.kind === 'builtin') {
    ctx.rotate((view.rotation * Math.PI) / 2);
    if (view.mirror) ctx.scale(-1, 1);
    if (view.rotation % 2) [fw, fh] = [h, w];
  }
  ctx.translate(cal.x * fw, cal.y * fh);
  ctx.rotate((cal.rot * Math.PI) / 2);
  if (cal.flip) ctx.scale(-1, 1);
  const vw = vis.width, vh = vis.height;
  // Cover the frame (after the extra rotation), then zoom.
  const [rw, rh] = cal.rot % 2 ? [vh, vw] : [vw, vh];
  const k = Math.max(fw / rw, fh / rh) * cal.s;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(vis.image, (-vw * k) / 2, (-vh * k) / 2, vw * k, vh * k);
  ctx.restore();
  return true;
}

/** A screen-space drag (dx, dy as fractions of the frame's width and height) in the alignment's axes. */
export function dragToAlign(vis, view, dx, dy) {
  if (vis.kind !== 'builtin') return [dx, dy];
  // Undo the view's rotation and mirroring (see orient() in view.js).
  let X = dx, Y = dy;
  for (let i = 0; i < (4 - view.rotation) % 4; i++) [X, Y] = [-Y, X];
  if (view.mirror) X = -X;
  // Fractions are of the sensor frame, whose sides swap when the view is turned a quarter.
  return [X, Y];
}

/** Brightness (0–255) of the visible picture lined up with a W×H thermal frame, drawn via `canvas`. */
function visibleLuma(canvas, vis, view, W, H) {
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const sctx = canvas.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, W, H);
  drawVisible(sctx, vis, view, [0, 0, W, H]);
  const d = sctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < lum.length; i++) lum[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return lum;
}

/** Changes whenever the lined-up visible picture would. */
const visibleKey = (vis, view, W, H) => {
  const cal = vis.cal;
  return [vis.frameId, vis.image instanceof HTMLVideoElement ? performance.now() : 0, W, H,
    view.rotation, view.mirror, cal.s, cal.x, cal.y, cal.rot, cal.flip].join();
};

/** Working size for a w×h frame: at most `max` px on the long side. */
function workSize(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** High-pass "detail" layer from the visible picture, as greys around 128 for an 'overlay' blend. */
export class DetailLayer {
  constructor() {
    this.src = document.createElement('canvas');
    this.out = document.createElement('canvas');
    this.key = '';
  }

  /** Returns a canvas covering `rect`'s size, or null if there's no visible picture yet. */
  build(vis, view, w, h, strength) {
    if (!vis.ready) return null;
    // Work at up to ~480 px on the long side: plenty for edges, and fast.
    const [W, H] = workSize(w, h, 480);
    const key = visibleKey(vis, view, W, H) + ',' + strength;
    if (key === this.key) return this.out;
    this.key = key;
    const lum = visibleLuma(this.src, vis, view, W, H);
    const blur = boxBlur(lum, W, H, Math.max(1, Math.round(Math.max(W, H) / 160)));
    const gain = 1.5 + strength * 4.5;
    const out = this.out;
    if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
    const octx = out.getContext('2d');
    const px = octx.createImageData(W, H);
    const d = px.data;
    for (let i = 0; i < lum.length; i++) {
      const v = Math.max(0, Math.min(255, 128 + (lum[i] - blur[i]) * gain));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    octx.putImageData(px, 0, 0);
    return out;
  }
}

/** IMIX: the thermal picture's colours with the visible picture's texture in their brightness. Unlike
 *  Fusion, the visible picture's own colours and overall lighting never show; unlike Detail, it carries
 *  whole surfaces (text, fabric, shading), not just outlines, and lifts the cold end out of black. */
export class ImixLayer {
  constructor() {
    this.src = document.createElement('canvas');
    this.out = document.createElement('canvas');
    this.key = '';
    this.tex = null;
  }

  /** `thermal` is the colourised thermal frame (any size); returns a canvas of about w×h, or null. */
  build(vis, view, thermal, w, h, amount) {
    if (!vis.ready) return null;
    const [W, H] = workSize(w, h, 640);
    const key = visibleKey(vis, view, W, H);
    if (key !== this.key) {
      this.key = key;
      this.tex = texture(visibleLuma(this.src, vis, view, W, H), W, H);
    }
    const out = this.out;
    if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(thermal, 0, 0, W, H);
    const px = octx.getImageData(0, 0, W, H);
    const d = px.data, tex = this.tex;
    // Brightness only: each pixel's three channels move by the same amount, so its hue stays. The texture
    // is added on top of the thermal brightness, and the darkest colours are lifted a little so the
    // texture also shows where the palette is near black.
    const lift = 28 * amount, keep = 1 - lift / 255, gain = 1.3 * amount;
    for (let i = 0, j = 0; i < tex.length; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const y = r * 0.299 + g * 0.587 + b * 0.114;
      const shift = lift - y * (1 - keep) + (tex[i] - 128) * gain;
      d[j] = r + shift; // clamped by the Uint8ClampedArray
      d[j + 1] = g + shift;
      d[j + 2] = b + shift;
    }
    octx.putImageData(px, 0, 0);
    return out;
  }
}

/** The visible picture's texture as brightness around mid-grey, with its contrast normalised so a dim or
 *  flat scene still gives clear detail. Most of the large-scale lighting is taken out (thermal supplies
 *  that), but not all: removing all of it rings every strong edge with a dark halo. */
function texture(lum, W, H) {
  const n = lum.length;
  const base = boxBlur(lum, W, H, Math.max(2, Math.round(Math.max(W, H) / 20)));
  // A touch of smoothing takes the edge off sensor noise and JPEG blocks.
  const fine = boxBlur(lum, W, H, 1);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += lum[i];
  mean /= n;
  const t = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = fine[i] - 0.7 * base[i] - 0.3 * mean;
    t[i] = v;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n) || 1;
  const gain = 40 / Math.max(rms, 4);
  for (let i = 0; i < n; i++) t[i] = Math.max(0, Math.min(255, 128 + t[i] * gain));
  return t;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pass = (a, b, len, count, stride, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += a[base + Math.min(len - 1, Math.max(0, i)) * step];
      for (let i = 0; i < len; i++) {
        b[base + i * step] = sum / (2 * r + 1);
        sum += a[base + Math.min(len - 1, i + r + 1) * step] - a[base + Math.max(0, i - r) * step];
      }
    }
  };
  pass(src, tmp, w, h, w, 1);
  pass(tmp, out, h, w, 1, w);
  return out;
}
