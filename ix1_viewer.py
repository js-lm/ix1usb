#!/usr/bin/env python3
"""Live viewer for the Raythink IX1 Go / Go Pro thermal camera.

Keys:  p palette | r rotate 90 | m mirror | s snapshot (PNG + CSV of temperatures) | q / Esc quit
Mouse: hover to read the temperature under the cursor.
"""
import os
import time

import cv2
import numpy as np

from ix1_camera import IX1, CameraError

SCALE = 5
PALETTES = [('inferno', cv2.COLORMAP_INFERNO), ('ironbow', cv2.COLORMAP_HOT), ('jet', cv2.COLORMAP_JET),
            ('turbo', cv2.COLORMAP_TURBO), ('magma', cv2.COLORMAP_MAGMA), ('gray', None)]
SNAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'snapshots')
WIN = 'IX1 thermal'


def label(img, text, org, scale=0.5):
    """White text on a translucent dark box (a thick black putText 'outline' drifts out of
    alignment, because OpenCV spaces glyphs by stroke thickness)."""
    font, pad = cv2.FONT_HERSHEY_SIMPLEX, 3
    (tw, th), base = cv2.getTextSize(text, font, scale, 1)
    x, y = org
    x0, y0 = max(x - pad, 0), max(y - th - pad, 0)
    x1, y1 = min(x + tw + pad, img.shape[1]), min(y + base + pad, img.shape[0])
    if x1 > x0 and y1 > y0:
        img[y0:y1, x0:x1] = (img[y0:y1, x0:x1] * 0.35).astype(img.dtype)
    cv2.putText(img, text, org, font, scale, (255, 255, 255), 1, cv2.LINE_AA)


def marker(img, pt, color, text):
    cv2.drawMarker(img, pt, color, cv2.MARKER_TILTED_CROSS, 14, 2)
    label(img, text, (pt[0] + 8, pt[1] - 8), 0.45)


def colorize(t, palette):
    lo, hi = float(t.min()), float(t.max())
    norm = ((t - lo) / max(hi - lo, 0.5) * 255).clip(0, 255).astype(np.uint8)
    if palette is None:
        return cv2.cvtColor(norm, cv2.COLOR_GRAY2BGR)
    return cv2.applyColorMap(norm, palette)


def main():
    mouse = {'pt': None}
    pal, rot, mirror = 0, 0, False

    def on_mouse(event, x, y, flags, param):
        mouse['pt'] = (x, y)

    try:
        cam = IX1().start()
    except CameraError as e:
        raise SystemExit(f'error: {e}')
    cv2.namedWindow(WIN, cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback(WIN, on_mouse)
    n = 0
    try:
        while True:
            f, n = cam.wait_frame(n, timeout=3)
            if f is None:
                raise SystemExit('no frames from camera')
            t = f.temp_c
            if mirror:
                t = t[:, ::-1]
            t = np.ascontiguousarray(np.rot90(t, -rot))
            h, w = t.shape
            img = cv2.resize(colorize(t, PALETTES[pal][1]), (w * SCALE, h * SCALE), interpolation=cv2.INTER_CUBIC)

            ymax, xmax = np.unravel_index(np.argmax(t), t.shape)
            ymin, xmin = np.unravel_index(np.argmin(t), t.shape)
            c = (w // 2, h // 2)
            to_img = lambda x, y: (int(x * SCALE + SCALE // 2), int(y * SCALE + SCALE // 2))
            marker(img, to_img(xmax, ymax), (0, 0, 255), f'{t[ymax, xmax]:.1f}C')
            marker(img, to_img(xmin, ymin), (255, 128, 0), f'{t[ymin, xmin]:.1f}C')
            cv2.drawMarker(img, to_img(*c), (255, 255, 255), cv2.MARKER_CROSS, 18, 1)
            if mouse['pt']:
                mx, my = mouse['pt']
                tx, ty = min(mx // SCALE, w - 1), min(my // SCALE, h - 1)
                marker(img, (mx, my), (0, 255, 0), f'{t[ty, tx]:.1f}C')

            label(img, f'center {t[c[1], c[0]]:.1f}C   min {t.min():.1f}C   max {t.max():.1f}C   '
                       f'{cam.fps:.0f} fps   [{PALETTES[pal][0]}]', (8, 20))
            label(img, 'p palette  r rotate  m mirror  s snapshot  q quit', (8, img.shape[0] - 10), 0.42)
            cv2.imshow(WIN, img)

            k = cv2.waitKey(1) & 0xff
            if k in (ord('q'), 27) or cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
                break
            if k == ord('p'):
                pal = (pal + 1) % len(PALETTES)
            elif k == ord('r'):
                rot = (rot + 1) % 4
            elif k == ord('m'):
                mirror = not mirror
            elif k == ord('s'):
                os.makedirs(SNAP_DIR, exist_ok=True)
                stem = os.path.join(SNAP_DIR, time.strftime('ix1_%Y%m%d_%H%M%S'))
                cv2.imwrite(stem + '.png', img)
                np.savetxt(stem + '.csv', t, fmt='%.2f', delimiter=',')
                print('saved', stem + '.png / .csv')
    finally:
        cam.close()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
