# Raythink IX1 Go / Go Pro thermal camera viewer

An unofficial live viewer for the Raythink IX1 Go / Go Pro USB-C thermal camera (USB `3474:1200`). It runs in the browser on Linux, macOS, Windows, and Android, and there's nothing to install.

> Not affiliated with or endorsed by Raythink / Raytron. Tested with one IX1 Go Pro.

## Website

Open the site in **Chrome or Edge**, plug in the camera and press **Connect camera**. Firefox and Safari don't support WebUSB. Once a browser has been allowed to use the camera, the page connects to it automatically whenever it's plugged in.

| Platform | First-time setup |
|---|---|
| Android | None. Use Chrome and plug the camera into the USB-C port. |
| macOS | None |
| Linux | Run `sh ix1-linux-setup.sh` ([`web/setup/ix1-linux-setup.sh`](web/setup/ix1-linux-setup.sh)) once and enter your password. It installs a udev rule so your user can open the camera. |
| Windows | Run [`IX1-Windows-Setup.cmd`](web/setup/IX1-Windows-Setup.cmd) once and click *Yes* at the admin prompt. It attaches Windows' built-in WinUSB driver to the camera (details [below](#windows-setup)). |

The site links to both setup files (they're also under the menu button). The layout follows the official phone app: portrait view, hot/cold/centre crosshairs, a tap-and-drag temperature probe, measurements, camera modes, palettes, flip and rotate, brightness and contrast, shutter calibration, photos (PNG), video, and saving the temperatures as CSV. Keys: `P` palette, `I` camera mode, `R` rotate, `M` mirror, `F` shutter calibration, `S` photo, `V` start/stop video, `C` save CSV.

**Camera modes** combine the thermal picture with a visible-light one: IR, Visible, PIP (movable, resizable inset; ⇄ swaps the two), Fusion (blend), Side by side, and Slider (drag a divider to wipe between them). **Detail**, under Image, draws edges from the visible picture onto the thermal one in any of them. The IX1 Go Pro streams its own visible camera; on other models the site uses the phone's or computer's camera instead (a Go Pro can use either). **Align** lines the two up: drag, pinch or scroll, and it's remembered per camera.

**Photos and video** are drawn separately from the screen at a fixed size: the thermal picture at 768 px on its short side (1024×768 for a 256×192 sensor, 768×1024 turned, twice as wide in side by side), with marker text sized to the picture rather than the window. **Markers** under Export turns the readings and measurements on them on or off. Photos carry the raw temperatures (°C to two decimals, which keeps the camera's 1/64 °C exactly), the view settings and the measurements as JSON in a compressed PNG `iTXt` chunk with the keyword `ix1-thermal`; `exiftool -b -Ix1-thermal photo.png` prints it.

**Video** gets one frame per camera frame, each stamped with the time the camera sent it, so it plays at the camera's own rate without the judder of sampling at a fixed rate. It's MP4 (WebM in older Chrome) at 8 Mbit/s for 1024×768. The size is set when recording starts; if you turn the view part way, the picture is fitted inside with black bars. In Chrome or Edge on a computer you pick the file before recording starts, and it's written as it records, one chunk a second, so memory use stays flat however long you record. Choosing a RAM-backed folder such as `/tmp` on Fedora keeps it off the SSD. Android Chrome has no save dialog, so there the video is held in memory and downloaded when you stop.

### Hosting

WebUSB only works on HTTPS pages (or `localhost`). [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes `web/` to GitHub Pages on every push to `main`. To turn it on, go to *Settings → Pages → Source* and choose *GitHub Actions*. The site is static, so any HTTPS host works.

### Developing

```sh
python3 serve.py   # then open http://127.0.0.1:8000 in Chrome
```

`serve.py` is `python3 -m http.server` with caching turned off; with plain `http.server`, Chrome can keep running an old copy of a script for a while after you edit it.

Use `localhost` or `127.0.0.1` in the address bar. Chrome doesn't treat `http://0.0.0.0:8000` or a LAN IP as secure, so WebUSB is unavailable there. To test on a phone, the site needs HTTPS, so use the GitHub Pages build.

There's no build step: the page loads its ES modules straight from `web/js/`.

| File | What it does |
|---|---|
| `web/js/ix1.js` | WebUSB driver. `IX1.open(device)`, `start()`, `onframe(frame)`, `ffc()`, `close()`. It doesn't touch the DOM, so it also runs under Node with the [`usb`](https://www.npmjs.com/package/usb) package's WebUSB implementation. |
| `web/js/view.js` | Draws frames on the canvas: palette, brightness and contrast, rotation and mirroring (portrait by default), the camera modes and Detail, plus a list of overlays. `drawCapture()` draws the same scene at the fixed photo/video size. |
| `web/js/capture.js` | Saved photos: the hidden canvas they're drawn on, and the temperatures and settings stored in the PNG. |
| `web/js/visible.js` | The visible picture (Go Pro JPEGs or the device camera), alignment, and the Detail layer. |
| `web/js/camera-ui.js` | The Camera sheet and the on-image controls (PIP box, slider, blend, alignment). |
| `web/js/image-ui.js` | The Image sheet's brightness, contrast and Detail tiles, their slider over the picture, and Reset all. |
| `web/js/palettes.js` | Colour lookup tables (generated from OpenCV colormaps). |
| `web/js/snapshot.js` | PNG / CSV downloads. |
| `web/js/record.js` | Video recording (`MediaRecorder` fed one timestamped frame per camera frame), streamed to a file where the browser allows it. |
| `web/js/main.js` | Page wiring: connect and disconnect, the tool sheets, photo/video, keyboard, the probe. |

Common extensions:

- **Something drawn on the image** (spot meters, boxes, isotherms): write `(ctx, image, view) => {...}` and push it onto `view.overlays`. `image.temp` holds the °C values. `view.toCanvas(x, y)` converts image pixels to canvas pixels.
- **A palette**: add an entry to `palettes.js`.
- **A button or shortcut**: add a function to `actions` in `main.js` and hook it up there.
- **Something per frame** (recording, alarms, graphs): `cam.onframe` in `main.js` receives every `Frame`. `frame.raw` also holds the camera's own preview image and the info lines.

### Windows setup

Windows won't let any program (Chrome included) open a USB device unless a driver is attached to it, and this camera has no driver Windows would install on its own. [`IX1-Windows-Setup.cmd`](web/setup/IX1-Windows-Setup.cmd) does the same job as [Zadig](https://zadig.akeo.ie), using only what ships with Windows:

1. It writes a driver package (an INF) that points the camera at Windows' built-in `winusb.sys`.
2. It signs the package's catalog with a certificate it creates on the spot. That certificate is trusted only on this PC, and its private key is deleted straight afterwards, so it can never sign anything else.
3. It installs the driver on the camera.

It downloads nothing. To undo it:
- In Device Manager, right-click **Raythink IX1 thermal camera** → *Uninstall device*, and tick *Attempt to remove the driver*.
- Optionally, in `certlm.msc`, delete the "IX1 thermal camera WinUSB" certificate from *Trusted Root Certification Authorities* and *Trusted Publishers*.

## Appendix

The camera presents itself as an Apple iAP2 accessory, but it also accepts the Raytron "AC020 DVS" vendor protocol that the Android TI Studio app uses. The protocol details below were worked out from that app.

- **Commands**: vendor control transfers to interface 0. Send `OUT 0x41/0x20` with an 18-byte block (`10 10 <id> 00×9 <len u32 LE> <crc16-xmodem LE>`), read the status with `IN 0xC1/0x22`, then read the result with `IN 0xC1/0x21`. Command `0xA7` returns the resolution.
- **Write commands** use ids below `0x80` and no data phase: send the block with `len` 0, then poll `IN 0xC1/0x22` until the status isn't 1 (busy); 2 or 3 means done. `10 02 43` is a flat-field correction (TI Studio's shutter button: the shutter clicks and the sensor recalibrates). TI Studio's brightness and contrast are `10 04 47 00 <0–100>` and `10 04 48 00 <0–100>`, but they only tune the camera's own processed image, which this site doesn't use; it applies brightness and contrast to its own palette mapping instead.
- **Stream**: select interface 1, alt setting 1, then send `OUT 0x40/0xEE` with `wValue=<stream index>` and `wIndex=1`. Frames arrive on bulk endpoint `0x81` with a 12-byte UVC-style header; header bit `0x02` marks the end of a frame (the camera sends it in a separate header-only packet). Selecting alt setting 0 stops the stream. The first frame after starting is garbage, so skip it.
- **Stream indices**: 0 IR + visible (YUYV), 1 IR only, 2 IR without temperatures, 3 visible MJPEG only, 4 IR + visible (NV12), 5 IR + visible (MJPEG). Command `0x99` returns 1 if the camera has a visible camera (Go Pro), and `0x9B` a mask of supported indices (bit n = index n; a Go Pro reports `0x3F`). TI Studio uses index 5 on a Go Pro, which is also the firmware's default; it resets the USB device whenever it changes index, so this site sticks to one index per connection.
- **Visible stream** (index 5): 1024×768 JPEGs (~35 KB each) on bulk endpoint `0x82` of interface 0, with the same UVC-style headers. The IR frames on `0x81` are unchanged. TI Studio fetches a factory alignment between the two cameras as a file from the device; this site uses a manual alignment instead.
- **Frame layout** (160×120, 25 fps):

  | Bytes | Contents |
  |---|---|
  | 38400 | YUYV preview image |
  | 38400 | uint16 LE temperature per pixel: °C = raw / 64 − 273.15 |
  | 640 | info lines |
