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

The site links to both setup files. Features: live view, min/max/centre markers, a temperature probe (hover with the mouse, or tap and drag on a phone), palettes, rotate, mirror, and saving the view as PNG or the temperatures as CSV. Keys: `P` palette, `R` rotate, `M` mirror, `S` save PNG, `C` save CSV.

### Hosting

WebUSB only works on HTTPS pages (or `localhost`). [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes `web/` to GitHub Pages on every push to `main`. To turn it on, go to *Settings → Pages → Source* and choose *GitHub Actions*. The site is static, so any HTTPS host works.

### Developing

```sh
python3 -m http.server -d web --bind 127.0.0.1 8000   # then open http://127.0.0.1:8000 in Chrome
```

Use `localhost` or `127.0.0.1` in the address bar. Chrome doesn't treat `http://0.0.0.0:8000` or a LAN IP as secure, so WebUSB is unavailable there. To test on a phone, the site needs HTTPS, so use the GitHub Pages build.

There's no build step: the page loads its ES modules straight from `web/js/`.

| File | What it does |
|---|---|
| `web/js/ix1.js` | WebUSB driver. `IX1.open(device)`, `start()`, `onframe(frame)`, `close()`. It doesn't touch the DOM, so it also runs under Node with the [`usb`](https://www.npmjs.com/package/usb) package's WebUSB implementation. |
| `web/js/view.js` | Draws frames on the canvas: palette, rotation and mirroring, plus a list of overlays. |
| `web/js/palettes.js` | Colour lookup tables (generated from OpenCV colormaps). |
| `web/js/snapshot.js` | PNG / CSV downloads. |
| `web/js/main.js` | Page wiring: connect and disconnect, buttons, keyboard, the probe. |

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
- **Stream**: select interface 1, alt setting 1, then send `OUT 0x40/0xEE` with `wValue=1` (IR-only stream) and `wIndex=1`. Frames arrive on bulk endpoint `0x81` with a 12-byte UVC-style header; header bit `0x02` marks the end of a frame. Selecting alt setting 0 stops the stream. The first frame after starting is garbage, so skip it.
- **Frame layout** (160×120, 25 fps):

  | Bytes | Contents |
  |---|---|
  | 38400 | YUYV preview image |
  | 38400 | uint16 LE temperature per pixel: °C = raw / 64 − 273.15 |
  | 640 | info lines |
