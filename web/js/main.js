// Page wiring: connects the camera driver (ix1.js) to the view (view.js) and the controls.

import { IX1, VID, PID } from './ix1.js';
import { ThermalView } from './view.js';
import { PALETTES } from './palettes.js';
import { savePNG, saveCSV } from './snapshot.js';

const $ = (id) => document.getElementById(id);
const view = new ThermalView($('view'));

let cam = null;     // IX1 while connected
let latest = null;  // newest Frame, drawn on the next animation frame
let drawQueued = false;

// ---- status / UI state ----

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

function setLive(live) {
  $('stage').classList.toggle('idle', !live);
  $('placeholder').hidden = live;
  $('connect').textContent = live ? 'Disconnect' : 'Connect camera';
  $('save-png').disabled = $('save-csv').disabled = !live;
  if (!live) {
    latest = null;
    for (const id of ['s-center', 's-min', 's-max', 's-probe', 's-fps']) $(id).textContent = '–';
  }
}

/** Open the setup instructions for this OS and draw attention to them. */
function showSetupHelp() {
  $('setup').classList.add('attention');
  const os = detectOS();
  const d = document.querySelector(`#setup details[data-os="${os}"]`);
  if (d) d.open = true;
}

function detectOS() {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  return '';
}

// ---- drawing ----

const fmt = (t) => `${t.toFixed(1)}°C`;

function draw() {
  drawQueued = false;
  if (!latest) return;
  view.draw(latest);
  const img = view.image;
  $('s-center').textContent = fmt(img.tempAt(img.width >> 1, img.height >> 1));
  $('s-min').textContent = fmt(img.min);
  $('s-max').textContent = fmt(img.max);
  $('s-probe').textContent = view.probe ? fmt(img.tempAt(view.probe.x, view.probe.y)) : '–';
  $('s-fps').textContent = cam ? cam.fps.toFixed(0) : '–';
}

function queueDraw() {
  if (!drawQueued) {
    drawQueued = true;
    requestAnimationFrame(draw);
  }
}

// ---- camera ----

let connecting = false;

async function connect(device) {
  if (cam || connecting) return;
  connecting = true;
  setStatus('Connecting…');
  try {
    const c = await IX1.open(device);
    c.onframe = (frame) => { latest = frame; queueDraw(); };
    c.onerror = (e) => disconnect(e.message, 'error');
    await c.start();
    cam = c;
    setLive(true);
    setStatus(`Live · ${c.width}×${c.height}`, 'live');
  } catch (e) {
    setStatus(e.message, 'error');
    showSetupHelp();
  } finally {
    connecting = false;
  }
}

async function disconnect(message = 'Not connected', kind = '') {
  const c = cam;
  cam = null;
  setLive(false);
  setStatus(message, kind);
  if (c) await c.close();
}

async function onConnectClick() {
  if (cam) return disconnect();
  try {
    await connect(await IX1.request());
  } catch (e) {
    // NotFoundError = the chooser was closed without picking anything (or the list was empty).
    if (e.name === 'NotFoundError') {
      setStatus('No camera selected. If it wasn\'t in the list, see the setup steps below.');
      showSetupHelp();
    } else {
      setStatus(e.message, 'error');
    }
  }
}

// ---- controls ----

const paletteSel = $('palette');
PALETTES.forEach((p, i) => paletteSel.add(new Option(`Palette: ${p.name}`, i)));
function updatePaletteLabel() { paletteSel.value = view.palette; }

const actions = {
  palette: () => { view.nextPalette(); updatePaletteLabel(); queueDraw(); },
  rotate: () => { view.rotate(); queueDraw(); },
  mirror: () => { view.toggleMirror(); queueDraw(); },
  savePNG: () => cam && view.image && savePNG(view.canvas),
  saveCSV: () => cam && view.image && saveCSV(view.image),
};

$('connect').onclick = onConnectClick;
paletteSel.onchange = () => { view.palette = +paletteSel.value; queueDraw(); };
$('rotate').onclick = actions.rotate;
$('mirror').onclick = actions.mirror;
$('save-png').onclick = actions.savePNG;
$('save-csv').onclick = actions.saveCSV;

const keys = { p: actions.palette, r: actions.rotate, m: actions.mirror, s: actions.savePNG, c: actions.saveCSV };
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  keys[e.key.toLowerCase()]?.();
});

// Probe: follows the mouse; on touch screens, tap or drag to place it.
const canvas = view.canvas;
const moveProbe = (e) => { view.probe = view.imagePointAt(e); queueDraw(); };
canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) moveProbe(e); });
canvas.addEventListener('pointerdown', moveProbe);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { view.probe = null; queueDraw(); } });
window.addEventListener('resize', queueDraw);

// ---- start-up ----

updatePaletteLabel();
setLive(false);

if (!navigator.usb) {
  // Chrome hides navigator.usb on insecure pages (plain http other than localhost), so check that first.
  if (!window.isSecureContext) {
    $('insecure').hidden = false;
    const local = new URL(location.href);
    local.hostname = 'localhost';
    $('local-link').href = $('local-link').textContent = local.href;
  } else {
    $('unsupported').hidden = false;
  }
  $('connect').disabled = true;
  setStatus('WebUSB not available', 'error');
} else {
  const isIX1 = (d) => d.vendorId === VID && d.productId === PID;
  // Once the site has permission, plugging the camera in connects it automatically.
  navigator.usb.addEventListener('connect', (e) => { if (isIX1(e.device)) connect(e.device); });
  navigator.usb.addEventListener('disconnect', (e) => {
    if (!isIX1(e.device)) return;
    if (cam && e.device === cam.device) disconnect('Camera unplugged');
    else if (!cam) setStatus('Camera unplugged'); // the stream error may have got there first
  });
  IX1.paired().then((devices) => devices[0] && connect(devices[0]));
  window.addEventListener('pagehide', () => cam?.close());
}
