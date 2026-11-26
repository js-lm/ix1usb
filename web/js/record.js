import { stamp, download } from './snapshot.js';

// Chrome can write MP4 (H.264) directly since v126; older versions fall back to WebM.
// Level 4.0 (…0028) first: 3.1 tops out below a side-by-side frame (2056×768).
const TYPES = [
  'video/mp4;codecs=avc1.420028',
  'video/mp4;codecs=avc1.42E01F',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;

/** 8 Mbit/s at 1024×768, more for bigger frames: enough that small text stays sharp. */
const bitrate = (w, h) => Math.round(Math.min(16e6, Math.max(8e6, (8e6 * w * h) / (1024 * 768))));

/** Chrome can take frames with their own timestamps (MediaStreamTrackGenerator). */
const canStamp = () => typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function';

/** Records a canvas. Frames are taken only when frame() is called, once per camera frame, so the video
 *  runs at the camera's own rate with each frame on screen for as long as it really lasted; a fixed rate
 *  would repeat or drop frames and stutter.
 *
 *  Each frame is handed over with the time the camera sent it. The simpler canvas.captureStream() takes
 *  the frame at the next screen refresh instead, which turns a steady 25 fps into an uneven 33/50 ms
 *  rhythm on a 60 Hz screen; it's used only where the timestamped way isn't available. */
export class Recorder {
  constructor() {
    this.recorder = null;
    this.track = null;
    this.writer = null;
    /** [w, h] of the video while recording; it can't change part way. */
    this.size = null;
    this.busy = false;
    this.onerror = null;
  }

  get recording() { return !!this.recorder; }
  get elapsed() { return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0; }

  /** Call from a click or key press: the save dialog needs a user gesture. `canvas` should already hold
   *  the first frame, at the size the whole video will be. Resolves to false if the user cancelled. */
  async start(canvas) {
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

      let stream;
      if (canStamp()) {
        const gen = new MediaStreamTrackGenerator({ kind: 'video' });
        this.writer = gen.writable.getWriter();
        stream = new MediaStream([gen]);
      } else {
        stream = canvas.captureStream(0);
        this.track = stream.getVideoTracks()[0];
      }
      this.canvas = canvas;
      this.lastStamp = -Infinity;
      this.size = [canvas.width, canvas.height];
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate(canvas.width, canvas.height) });
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
      this.frame();
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Adds the canvas as it is now as the next frame, shown from `time` (performance.now() ms; the
   *  camera frame's arrival time) until the next one. */
  frame(time = performance.now()) {
    if (!this.recorder) return;
    if (!this.writer) { this.track?.requestFrame(); return; }
    const timestamp = Math.round(time * 1000);
    if (timestamp <= this.lastStamp) return;
    this.lastStamp = timestamp;
    const vf = new VideoFrame(this.canvas, { timestamp });
    this.writer.write(vf).catch(() => {}).finally(() => vf.close());
  }

  async stop() {
    const rec = this.recorder;
    if (!rec) return null;
    this.recorder = null;
    this.track = null;
    this.size = null;
    const writer = this.writer;
    this.writer = null;
    rec.stop();
    await this.stopped;
    writer?.close().catch(() => {});
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
