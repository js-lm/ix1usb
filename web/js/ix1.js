// WebUSB driver for the Raythink IX1 Go / Go Pro thermal camera (USB 3474:1200).
// This module only touches the USBDevice it's given (no DOM), so it also runs under Node with
// the `usb` package's WebUSB implementation.

export const VID = 0x3474;
export const PID = 0x1200;
export const USB_FILTERS = [{ vendorId: VID, productId: PID }];

const CMD_IFACE = 0;
const STREAM_IFACE = 1;
const STREAM_EP = 1;
const STREAM_IR_ONLY = 1;
const TRANSFER_SIZE = 512 * 1024;
const TRANSFERS_IN_FLIGHT = 3;

function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** 18-byte read-command block: 10 10 <id> 00*9 <len u32 LE> <crc16 LE>. */
export function commandBlock(cmdId, dataLen) {
  const b = new Uint8Array(18);
  const v = new DataView(b.buffer);
  b[0] = 0x10; b[1] = 0x10; b[2] = cmdId;
  v.setUint32(12, dataLen, true);
  v.setUint16(16, crc16xmodem(b.subarray(0, 16)), true);
  return b;
}

export class CameraError extends Error {}

export class TempImage {
  constructor(temp, width, height) {
    this.temp = temp;
    this.width = width;
    this.height = height;
    let min = 0, max = 0;
    for (let i = 1; i < temp.length; i++) {
      if (temp[i] < temp[min]) min = i;
      if (temp[i] > temp[max]) max = i;
    }
    this.minIndex = min;
    this.maxIndex = max;
  }

  get min() { return this.temp[this.minIndex]; }
  get max() { return this.temp[this.maxIndex]; }
  tempAt(x, y) { return this.temp[y * this.width + x]; }
}

export class Frame extends TempImage {
  constructor(bytes, width, height) {
    const n = width * height;
    const raw = new DataView(bytes.buffer, bytes.byteOffset + n * 2, n * 2);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = raw.getUint16(i * 2, true) / 64 - 273.15;
    super(t, width, height);
    this.time = performance.now();
    this.raw = bytes;
  }
}

export class IX1 {
  static async request(usb = navigator.usb) {
    return usb.requestDevice({ filters: USB_FILTERS });
  }

  static async paired(usb = navigator.usb) {
    return (await usb.getDevices()).filter((d) => d.vendorId === VID && d.productId === PID);
  }

  static async open(device) {
    const cam = new IX1(device);
    await cam._init();
    return cam;
  }

  constructor(device) {
    this.device = device;
    this.width = 0;
    this.height = 0;
    this.fps = 0;
    this.frameCount = 0;
    this.streaming = false;
    this.onframe = null;
    this.onerror = null;
  }

  async _init() {
    const d = this.device;
    try {
      if (!d.opened) await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      await d.claimInterface(CMD_IFACE);
      await d.claimInterface(STREAM_IFACE);
      await d.selectAlternateInterface(STREAM_IFACE, 0); // stop any stream a previous session left running
    } catch (e) {
      throw new CameraError(`cannot open the camera (${e.message}). Is another app or tab using it?`);
    }
    let [w, h] = await this.readU16Pair(0xa7);
    const known = (a, b) => [[160, 120], [256, 192], [128, 128], [104, 104]].some(([x, y]) => x === a && y === b);
    if (!known(w, h) && known(h, w)) [w, h] = [h, w];
    this.width = w;
    this.height = h;
    this.frameBytes = w * h * 4 + w * 4;
  }

  async read(cmdId, n) {
    const d = this.device;
    const setup = (request) => ({ requestType: 'vendor', recipient: 'interface', request, value: 0, index: CMD_IFACE });
    await d.controlTransferOut(setup(0x20), commandBlock(cmdId, n));
    await d.controlTransferIn(setup(0x22), 1);
    const r = await d.controlTransferIn(setup(0x21), n);
    if (r.status !== 'ok' || r.data.byteLength < n) throw new CameraError(`command 0x${cmdId.toString(16)} failed`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async readU16Pair(cmdId) {
    const b = await this.read(cmdId, 4);
    const v = new DataView(b.buffer, b.byteOffset);
    return [v.getUint16(0, true), v.getUint16(2, true)];
  }

  async info() {
    const u16 = async (id) => { const b = await this.read(id, 2); return b[0] | (b[1] << 8); };
    return {
      resolution: [this.width, this.height],
      visibleLightSupport: (await this.read(0x99, 1))[0],
      previewModeMask: '0x' + (await u16(0x9b)).toString(16),
      mfiStatus: (await this.read(0x98, 1))[0],
    };
  }

  async start(streamIdx = STREAM_IR_ONLY) {
    if (this.streaming) return;
    const d = this.device;
    await d.selectAlternateInterface(STREAM_IFACE, 1);
    await d.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0xee, value: streamIdx, index: 1 });
    this.streaming = true;
    this._loop = this._readLoop();
  }

  async _readLoop() {
    const buf = new Uint8Array(this.frameBytes + TRANSFER_SIZE);
    let len = 0;
    let skip = 1; // the first frame after starting the stream is uninitialised garbage
    let fpsT = performance.now(), fpsN = this.frameCount;
    const queue = [];
    const submit = () => queue.push(this.device.transferIn(STREAM_EP, TRANSFER_SIZE));
    for (let i = 0; i < TRANSFERS_IN_FLIGHT; i++) submit();
    try {
      while (this.streaming) {
        const r = await queue.shift();
        if (this.streaming) submit();
        if (r.status !== 'ok' || !r.data) continue;
        const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        const hlen = b[0], flags = b[1];
        if (b.length < 2 || hlen < 2 || hlen > b.length) continue;
        const payload = b.subarray(hlen);
        if (len + payload.length <= buf.length) buf.set(payload, len);
        len += payload.length;
        if (flags & 0x02) {
          if (len === this.frameBytes && skip-- <= 0) {
            const frame = new Frame(buf.slice(0, len), this.width, this.height);
            this.frameCount++;
            const now = performance.now();
            if (now - fpsT >= 1000) {
              this.fps = ((this.frameCount - fpsN) * 1000) / (now - fpsT);
              fpsT = now; fpsN = this.frameCount;
            }
            this.onframe?.(frame);
          }
          len = 0;
        }
      }
    } catch (e) {
      if (this.streaming) {
        this.streaming = false;
        this.onerror?.(new CameraError(`USB error: ${e.message}`));
      }
    }
    await Promise.allSettled(queue);
  }

  async stop() {
    if (!this.streaming) return;
    this.streaming = false;
    try { await this.device.selectAlternateInterface(STREAM_IFACE, 0); } catch {}
    await this._loop;
  }

  async close() {
    await this.stop();
    try { await this.device.close(); } catch {}
  }
}
