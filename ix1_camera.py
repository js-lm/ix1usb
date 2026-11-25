#!/usr/bin/env python3
"""Linux driver for the Raythink IX1 Go / IX1 Go Pro thermal camera (USB 3474:1200).

The camera enumerates as an Apple iAP2 accessory, but the iAP2 handshake isn't needed: it also
speaks the Raytron "AC020/DVS" protocol (the one the Android TI Studio app uses):

  * Commands: vendor control transfers on interface 0
      OUT 0x41 req 0x20  18-byte command block (CRC16-XMODEM of bytes 0..15, little-endian, in 16..17)
      IN  0xC1 req 0x22  1-byte status
      IN  0xC1 req 0x21  result bytes
  * Video: interface 1 alt 1, then vendor request OUT 0x40 req 0xEE wValue=<stream idx> wIndex=1,
    then UVC-style payloads (12-byte header) on bulk EP 0x81.

Stream index 1 (IR only) frame layout for a W x H sensor (160 x 120 on the IX1 Go Pro):
    [W*H*2  YUYV preview image (camera's own AGC)]
    [W*H*2  uint16 LE temperature, kelvin * 64]
    [W*4    2 info lines]
"""
import struct
import threading
import time

import numpy as np
import usb.core
import usb.util

VID, PID = 0x3474, 0x1200
DATA_IN = 0x81
STREAM_IR_ONLY = 1


def _crc16_xmodem(data):
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xffff if crc & 0x8000 else (crc << 1) & 0xffff
    return crc


def command_block(cmd_id, data_len):
    """18-byte read-command block: 10 10 <id> 00*9 <len u32 LE> <crc16 LE>."""
    b = bytes([0x10, 0x10, cmd_id]) + bytes(9) + struct.pack('<I', data_len)
    return b + struct.pack('<H', _crc16_xmodem(b))


class CameraError(Exception):
    pass


class IX1:
    """Open the camera and stream frames in a background thread.

    cam = IX1().start(); frame, n = cam.wait_frame(); frame.temp_c -> (H, W) float32 in degrees C.
    """

    def __init__(self, reset=True):
        self.dev = self._find(reset)
        try:
            usb.util.claim_interface(self.dev, 0)
        except usb.core.USBError as e:
            raise CameraError(f'cannot claim camera ({e}); is another program using it?') from e
        w, h = self.read_u16_pair(0xA7)
        if (w, h) not in ((160, 120), (256, 192), (128, 128), (104, 104)) and (h, w) in ((160, 120), (256, 192)):
            w, h = h, w
        self.width, self.height = w, h
        self.frame_bytes = w * h * 4 + w * 4
        self.cv = threading.Condition()
        self.frame = None
        self.nframe = 0
        self.fps = 0.0
        self.error = None
        self.run = False

    # ---- discovery / commands ----
    @staticmethod
    def _find(reset):
        d = usb.core.find(idVendor=VID, idProduct=PID)
        if d is None:
            raise CameraError('IX1 camera (3474:1200) not found - is it plugged in?')
        if not reset:
            return d
        try:
            d.reset()
        except usb.core.USBError:
            pass  # re-enumeration makes the old handle invalid; expected
        time.sleep(1.0)
        end = time.time() + 8
        while time.time() < end:
            d = usb.core.find(idVendor=VID, idProduct=PID)
            if d is not None:
                return d
            time.sleep(0.3)
        raise CameraError('camera did not come back after USB reset')

    def read(self, cmd_id, n):
        d = self.dev
        d.ctrl_transfer(0x41, 0x20, 0, 0, command_block(cmd_id, n), 2000)
        d.ctrl_transfer(0xC1, 0x22, 0, 0, 1, 2000)
        return bytes(d.ctrl_transfer(0xC1, 0x21, 0, 0, n, 2000))

    def read_u16_pair(self, cmd_id):
        return struct.unpack('<HH', self.read(cmd_id, 4))

    def info(self):
        return {
            'resolution': (self.width, self.height),
            'visible_light_support': self.read(0x99, 1)[0],
            'preview_mode_mask': hex(struct.unpack('<H', self.read(0x9B, 2))[0]),
            'mfi_status': self.read(0x98, 1)[0],
        }

    # ---- streaming ----
    def start(self, stream_idx=STREAM_IR_ONLY):
        usb.util.claim_interface(self.dev, 1)
        self.dev.set_interface_altsetting(1, 1)
        self.dev.ctrl_transfer(0x40, 0xEE, stream_idx, 1, None, 1000)
        self.run = True
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()
        return self

    def _reader(self):
        buf = bytearray()
        t_last, n_last = time.time(), 0
        while self.run:
            try:
                b = self.dev.read(DATA_IN, 512 * 1024, 1000)
            except usb.core.USBTimeoutError:
                continue
            except usb.core.USBError as e:
                if self.run:
                    self.error = e
                self.run = False
                break
            if len(b) < 2 or b[0] < 2 or b[0] > len(b):
                continue
            hlen, flags = b[0], b[1]
            buf += b[hlen:]
            if flags & 0x02:  # end of frame
                if len(buf) == self.frame_bytes:
                    fr = Frame(bytes(buf), self.width, self.height)
                    with self.cv:
                        self.frame = fr
                        self.nframe += 1
                        now = time.time()
                        if now - t_last >= 1.0:
                            self.fps = (self.nframe - n_last) / (now - t_last)
                            t_last, n_last = now, self.nframe
                        self.cv.notify_all()
                buf.clear()
        with self.cv:
            self.cv.notify_all()

    def wait_frame(self, after=0, timeout=3.0):
        """Block until a frame newer than #after arrives; returns (frame, number)."""
        with self.cv:
            self.cv.wait_for(lambda: self.nframe > after or not self.run, timeout)
            if self.error:
                raise CameraError(f'USB error: {self.error}')
            return self.frame, self.nframe

    def close(self):
        self.run = False
        if getattr(self, 'thread', None):
            self.thread.join(2)
        try:
            self.dev.set_interface_altsetting(1, 0)  # stops the stream
        except usb.core.USBError:
            pass
        usb.util.dispose_resources(self.dev)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class Frame:
    def __init__(self, raw, w, h):
        a = np.frombuffer(raw, np.uint8)
        n = w * h * 2
        self.preview = a[:n].reshape(h, w * 2)[:, 0::2]  # Y channel of the camera's YUYV image
        self.raw_temp = np.frombuffer(raw, '<u2', count=w * h, offset=n).reshape(h, w)
        self.temp_c = self.raw_temp.astype(np.float32) / 64.0 - 273.15
        self.info = a[2 * n:]


if __name__ == '__main__':
    with IX1() as cam:
        print(cam.info())
        cam.start()
        n = 0
        for _ in range(30):
            f, n = cam.wait_frame(n)
        t = f.temp_c
        print(f'{cam.fps:.1f} fps  min {t.min():.1f} C  max {t.max():.1f} C  center {t[cam.height // 2, cam.width // 2]:.1f} C')
