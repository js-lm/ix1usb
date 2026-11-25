import { stamp, download } from './snapshot.js';

// Chrome can write MP4 (H.264) directly since v126; older versions fall back to WebM.
const TYPES = [
  'video/mp4;codecs=avc1.42E01F',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.recorder = null;
    this.busy = false;
    this.onerror = null;
  }

  get recording() { return !!this.recorder; }
  get elapsed() { return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0; }

  /** Call from a click or key press: the save dialog needs a user gesture.
   *  Resolves to false if the user cancelled the dialog. */
  async start() {
    if (this.recorder || this.busy) return false;
    this.busy = true;
    try {
      const mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      if (!mime) throw new Error("this browser can't record video");
      const base = mime.split(';')[0];
      const ext = base === 'video/mp4' ? 'mp4' : 'webm';
      this.mime = base;
      this.name = `ix1_${stamp()}.${ext}`;
      this.file = null;
      this.chunks = [];

      if (window.showSaveFilePicker) {
        let handle;
        try {
          handle = await window.showSaveFilePicker({
            id: 'ix1-video',
            startIn: 'videos',
            suggestedName: this.name,
            types: [{ description: 'Video', accept: { [base]: [`.${ext}`] } }],
          });
        } catch (e) {
          if (e.name === 'AbortError') return false;
          throw e;
        }
        this.file = await handle.createWritable();
        this.name = handle.name;
      }

      const rec = new MediaRecorder(this.canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      this.writes = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        if (!this.file) { this.chunks.push(e.data); return; }
        const file = this.file;
        this.writes = this.writes
          .then(() => file.write(e.data))
          .catch((err) => { if (!this.writeError) { this.writeError = err; this.onerror?.(err); } });
      };
      this.stopped = new Promise((resolve) => { rec.onstop = resolve; });
      this.writeError = null;
      rec.start(1000);
      this.recorder = rec;
      this.startedAt = performance.now();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    const rec = this.recorder;
    if (!rec) return null;
    this.recorder = null;
    rec.stop();
    await this.stopped;
    rec.stream.getTracks().forEach((t) => t.stop());
    if (this.file) {
      await this.writes;
      await this.file.close();
      this.file = null;
      return { name: this.name, blob: null };
    }
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    download(blob, this.name);
    return { name: this.name, blob };
  }
}
