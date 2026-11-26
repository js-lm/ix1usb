// Saved photos: drawn at a fixed size (see ThermalView.drawCapture), with the raw temperatures and the
// view settings stored inside the PNG so a later tool can re-measure or redraw it.
//
// The data is one compressed iTXt chunk, keyword "ix1-thermal", holding UTF-8 JSON (see photoMeta).
// Image viewers ignore it. Read it with e.g. `exiftool -b -Ix1-thermal photo.png`, or any PNG library
// that reads text chunks. Chat apps and social media usually strip it; copying the file keeps it.

import { PALETTES } from './palettes.js';
import { MODES } from './view.js';
import { KINDS, diffLabel } from './measure.js';

export const META_KEYWORD = 'ix1-thermal';

/** A canvas the page keeps but never shows, for drawing saved photos and video frames. It sits in the
 *  page because some browsers stop capturing video from a canvas that isn't. */
export function captureCanvas() {
  const c = document.createElement('canvas');
  c.setAttribute('aria-hidden', 'true');
  c.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(c);
  return c;
}

const r2 = (v) => Math.round(v * 100) / 100;
const pt = (p) => p.map(r2);

/** Everything needed to rebuild the picture: temperatures in sensor order, and how they were shown. */
export function photoMeta(view, frame, { markers }) {
  const m = view.measure;
  const geometry = (item) => {
    switch (item.kind) {
      case 'point': return { p: pt(item.p) };
      case 'line': case 'rect': return { a: pt(item.a), b: pt(item.b) };
      case 'circle': return { c: pt(item.c), r: r2(item.r) };
    }
  };
  const stats = (st) => st && { max: r2(st.max), min: r2(st.min), avg: r2(st.avg) };
  const { width: w, height: h, temp } = frame;
  return {
    format: META_KEYWORD,
    version: 1,
    time: new Date().toISOString(),
    sensor: { width: w, height: h },
    temperatures: {
      unit: '°C',
      // The camera's resolution is 1/64 °C; two decimals keep it exactly (round((t + 273.15) * 64)).
      layout: 'row-major from the top-left, in sensor orientation (before the view\'s mirror and rotation)',
      values: Array.from(temp, r2),
    },
    view: {
      // orient() in view.js: mirror left-right first, then turn clockwise by rotation × 90°.
      mirror: view.mirror,
      rotation: view.rotation,
      palette: PALETTES[view.palette].name,
      brightness: view.brightness,
      contrast: view.contrast,
      mode: MODES[view.shownMode],
      markers,
    },
    readings: {
      max: r2(frame.max),
      min: r2(frame.min),
      center: r2(frame.tempAt(w >> 1, h >> 1)),
      shown: { center: view.showCenter, max: view.showMax, min: view.showMin },
    },
    // Geometry in sensor pixels (x right, y down, before mirror and rotation), so it lines up with
    // `temperatures`; circles' r is in pixels.
    measurements: m.items.map((item) => ({ name: item.name, kind: KINDS[item.kind].label.toLowerCase(), ...geometry(item), stats: stats(item.stats) })),
    differences: m.diffs.map((d) => ({ name: d.name, of: diffLabel(d), value: Number.isFinite(d.value) ? r2(d.value) : null })),
  };
}

// ---- PNG text chunk ----

let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `png` with a compressed iTXt chunk (keyword → UTF-8 text) added right after its header. */
export async function addPngText(png, keyword, text) {
  const enc = new TextEncoder();
  const body = await zlib(enc.encode(text));
  // keyword \0, compressed = 1, method = 0 (zlib), language "" \0, translated keyword "" \0, text
  const head = [...enc.encode(keyword), 0, 1, 0, 0, 0];
  const chunk = new Uint8Array(12 + head.length + body.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, head.length + body.length);
  chunk.set(enc.encode('iTXt'), 4);
  chunk.set(head, 8);
  chunk.set(body, 8 + head.length);
  dv.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  const bytes = new Uint8Array(await png.arrayBuffer());
  const afterHeader = 8 + 8 + new DataView(bytes.buffer).getUint32(8) + 4; // signature, IHDR
  return new Blob([bytes.subarray(0, afterHeader), chunk, bytes.subarray(afterHeader)], { type: 'image/png' });
}

/** A saved photo of `frame`: the picture as drawn by view.drawCapture, with photoMeta inside. */
export async function photo(view, frame, canvas, { markers }) {
  view.drawCapture(frame, canvas, { markers });
  // Read the settings now: the measurements' stats were just worked out for this frame.
  const meta = JSON.stringify(photoMeta(view, frame, { markers }));
  const png = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't encode the picture"))), 'image/png'));
  return addPngText(png, META_KEYWORD, meta);
}
