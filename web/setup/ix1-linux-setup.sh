#!/bin/sh
# Raythink IX1 thermal camera - one-time Linux setup.
# Installs a udev rule so your user account (and so Chrome/Edge) can open the camera without root.
# Run it with:  sh ix1-linux-setup.sh
set -e

RULE_FILE=/etc/udev/rules.d/70-raythink-ix1.rules
RULE='# Raythink IX1 Go / Go Pro thermal camera: let the logged-in user access it (WebUSB, libusb)
SUBSYSTEM=="usb", ATTRS{idVendor}=="3474", ATTRS{idProduct}=="1200", MODE="0660", TAG+="uaccess"'

if [ "$(id -u)" -ne 0 ]; then
    echo "Installing $RULE_FILE needs administrator rights; you'll be asked for your password."
    self=$(readlink -f "$0")
    if command -v pkexec >/dev/null 2>&1 && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
        exec pkexec sh "$self"
    fi
    exec sudo sh "$self"
fi

printf '%s\n' "$RULE" > "$RULE_FILE"
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --attr-match=idVendor=3474 || true
echo "Done. Replug the camera, then press 'Connect camera' on the website."
