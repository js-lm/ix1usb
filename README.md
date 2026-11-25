# Raythink IX1 Go Pro on Linux

An unofficial Linux driver and live viewer for the Raythink IX1 Go / Go Pro USB-C thermal camera (USB `3474:1200`).

> Not affiliated with or endorsed by Raythink / Raytron. Tested with one IX1 Go Pro on Fedora.

## Setup

```sh
sudo cp 70-raythink-ix1.rules /etc/udev/rules.d/ && sudo udevadm control --reload
python3 -m venv .venv && .venv/bin/pip install pyusb numpy opencv-python
```

Replug the camera after installing the udev rule.

## Usage

```sh
.venv/bin/python ix1_viewer.py    # live view
.venv/bin/python ix1_camera.py    # device info + one temperature reading
```

In the viewer, hover the mouse to read the temperature at that point. Keys: `p` palette, `r` rotate, `m` mirror, `s` snapshot (PNG + CSV of °C values in `snapshots/`), `q` quit.

To use the camera from your own code:

```python
from ix1_camera import IX1
with IX1() as cam:
    cam.start()
    frame, n = cam.wait_frame()
    frame.temp_c     # (120, 160) float32, °C
    frame.preview    # (120, 160) uint8, the camera's own contrast-adjusted image
```

## Appendix

The camera presents itself as an Apple iAP2 accessory, but it also accepts the Raytron "AC020 DVS" vendor protocol that the Android TI Studio app uses. The protocol details below were worked out from that app.

- **Commands**: vendor control transfers to interface 0. Send `OUT 0x41/0x20` with an 18-byte block (`10 10 <id> 00×9 <len u32 LE> <crc16-xmodem LE>`), read the status with `IN 0xC1/0x22`, then read the result with `IN 0xC1/0x21`. Command `0xA7` returns the resolution.
- **Stream**: select interface 1, alt setting 1, then send `OUT 0x40/0xEE` with `wValue=1` (IR-only stream) and `wIndex=1`. Frames arrive on bulk endpoint `0x81` with a 12-byte UVC-style header; header bit `0x02` marks the end of a frame. Selecting alt setting 0 stops the stream.
- **Frame layout** (160×120, 25 fps):

  | Bytes | Contents |
  |---|---|
  | 38400 | YUYV preview image |
  | 38400 | uint16 LE temperature per pixel: °C = raw / 64 − 273.15 |
  | 640 | info lines |
