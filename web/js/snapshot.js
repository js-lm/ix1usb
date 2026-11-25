// Saving what's on screen: PNG of the canvas (with overlays) and CSV of the temperatures.

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function savePNG(canvas) {
  canvas.toBlob((blob) => download(blob, `ix1_${stamp()}.png`), 'image/png');
}

/** One row per image row, °C with 2 decimals. */
export function saveCSV(image) {
  const { width: w, height: h, temp } = image;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Array.from(temp.subarray(y * w, (y + 1) * w), (t) => t.toFixed(2)).join(','));
  download(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), `ix1_${stamp()}.csv`);
}
