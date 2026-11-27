import { IX1, VID, PID } from './ix1.js';
import { ThermalView } from './view.js';
import { PALETTES } from './palettes.js';
import { saveCSV, download, stamp } from './snapshot.js';
import { Recorder, canRecord } from './record.js';
import { captureCanvas, photo } from './capture.js';
import { setupMeasure } from './measure-ui.js';
import { setupCamera } from './camera-ui.js';
import { setupImage } from './image-ui.js';
import { setupScene } from './scene-ui.js';
import { VisibleSource, store } from './visible.js';

const $ = (id) => document.getElementById(id);
const view = new ThermalView($('view'), $('stage'));
const vis = (view.vis = new VisibleSource());
const recorder = new Recorder();
/** Saved photos and videos are drawn here, at a fixed size, not taken from the screen. */
const capCanvas = captureCanvas();
/** markers: draw readings and measurements on saved photos and videos. */
const output = store.get('ix1.output', { markers: true });
const saveOutput = () => store.set('ix1.output', output);

let cam = null;
let latest = null;
let drawQueued = false;
let videoMode = false;
let probeOn = true;
let calibrating = false;

let statusText = '', statusKind = '';
function setStatus(text, kind = '') {
  statusText = text;
  statusKind = kind;
  renderStatus();
}
function renderStatus() {
  const s = $('status');
  if (cam && statusKind === 'live') {
    s.textContent = `Live · ${cam.width}×${cam.height} · ${cam.fps.toFixed(0)} fps`;
  } else {
    s.textContent = statusText;
  }
  s.className = `status ${statusKind}`;
}
let flashTimer = 0;
function flash(text, kind = '') {
  const prev = [statusText, statusKind];
  setStatus(text, kind);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (statusText === text) setStatus(...(cam ? ['', 'live'] : prev)); }, 3000);
}

function setLive(live) {
  $('stage').classList.toggle('idle', !live);
  $('placeholder').hidden = live;
  const btn = $('connect');
  btn.classList.toggle('on', live);
  btn.ariaLabel = live ? 'Disconnect camera' : 'Connect camera';
  btn.querySelector('use').setAttribute('href', live ? '#i-unplug' : '#i-plug');
  $('shutter').disabled = !live;
  $('ffc').disabled = !live || calibrating;
  $('save-png').disabled = $('save-csv').disabled = !live;
  if (!live) {
    latest = null;
    for (const id of ['r-center', 'r-probe', 'r-max', 'r-min']) $(id).textContent = '–';
    updateProbeToggle();
  }
}

function showSetupHelp() {
  const os = detectOS();
  const d = document.querySelector(`#help details[data-os="${os}"]`);
  if (d) d.open = true;
  if (!$('help').open) $('help').showModal();
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

const fmt = (t) => `${t.toFixed(1)}°C`;

let lastStatusUpdate = 0;
function draw() {
  drawQueued = false;
  if (!latest) return;
  view.draw(latest);
  const img = view.image;
  $('r-center').textContent = fmt(img.tempAt(img.width >> 1, img.height >> 1));
  $('r-max').textContent = fmt(img.max);
  $('r-min').textContent = fmt(img.min);
  $('r-probe').textContent = !probeOn ? 'Off' : view.probe ? fmt(img.tempAt(view.probe.x, view.probe.y)) : '–';
  sceneUI.update();
  measure.update();
  camUI.update();
  imageUI.update();
  const now = performance.now();
  if (now - lastStatusUpdate > 1000) { lastStatusUpdate = now; renderStatus(); }
}

function queueDraw() {
  if (!drawQueued) {
    drawQueued = true;
    requestAnimationFrame(draw);
  }
}

let connecting = false;

async function connect(device) {
  if (cam || connecting) return;
  connecting = true;
  setStatus('Connecting…');
  try {
    const c = await IX1.open(device);
    c.onframe = (frame) => {
      latest = frame;
      queueDraw();
      // One video frame per camera frame, drawn now rather than on the next screen refresh, so frames
      // are evenly spaced and none are skipped or doubled.
      if (recorder.recording) {
        view.drawCapture(frame, capCanvas, { size: recorder.size, markers: output.markers });
        recorder.frame(frame.time);
      }
    };
    c.onvisible = (jpeg) => { if (camUI.wantsBuiltin) vis.pushJPEG(jpeg); };
    c.onerror = (e) => disconnect(e.message, 'error');
    await c.start();
    cam = c;
    setLive(true);
    setStatus('', 'live');
    camUI.refresh();
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
  if (recorder.recording) await stopRecording();
  setLive(false);
  setStatus(message, kind);
  camUI.refresh();
  if (c) await c.close();
}

async function onConnectClick() {
  if (cam) return disconnect();
  try {
    await connect(await IX1.request());
  } catch (e) {
    // NotFoundError = the chooser was closed without picking anything (or the list was empty).
    if (e.name === 'NotFoundError') {
      setStatus('No camera selected');
      showSetupHelp();
    } else {
      setStatus(e.message, 'error');
    }
  }
}

async function calibrate() {
  if (!cam || calibrating) return;
  calibrating = true;
  $('ffc').disabled = true;
  try {
    await cam.ffc();
    flash('Shutter calibrated', 'live');
  } catch (e) {
    if (cam) flash(`Calibration failed: ${e.message}`, 'error');
  } finally {
    calibrating = false;
    $('ffc').disabled = !cam;
  }
}

let lastCaptureUrl = null;

function setThumb(blob, from = view.canvas) {
  if (lastCaptureUrl) URL.revokeObjectURL(lastCaptureUrl);
  lastCaptureUrl = blob ? URL.createObjectURL(blob) : null;
  const t = $('thumb');
  const small = document.createElement('canvas');
  small.width = 112;
  small.height = Math.round((112 * from.height) / from.width) || 112;
  small.getContext('2d').drawImage(from, 0, 0, small.width, small.height);
  t.style.backgroundImage = `url(${small.toDataURL('image/jpeg', 0.8)})`;
  t.disabled = !lastCaptureUrl;
}

async function takePhoto() {
  if (!cam || !latest) return;
  let blob;
  try {
    blob = await photo(view, latest, capCanvas, { markers: output.markers });
  } catch (e) {
    return flash(`Photo failed: ${e.message}`, 'error');
  }
  download(blob, `ix1_${stamp()}.png`);
  setThumb(blob, capCanvas);
  flash('Photo saved', 'live');
}

let recTimer = 0;
async function startRecording() {
  if (!cam || recorder.recording) return;
  if (!canRecord()) return flash("This browser can't record video", 'error');
  if (!latest) return;
  let started;
  try {
    // The first frame sets the video's size for the whole recording.
    view.drawCapture(latest, capCanvas, { markers: output.markers });
    started = await recorder.start(capCanvas);
  } catch (e) {
    return flash(`Can't record: ${e.message}`, 'error');
  }
  if (!started) return;
  if (!cam) { await recorder.stop(); return; } // unplugged while the dialog was open
  setThumb(null);
  $('shutter').classList.add('recording');
  $('shutter').ariaLabel = 'Stop recording';
  $('mode').disabled = true;
  $('rec-badge').hidden = false;
  const tick = () => {
    const s = Math.floor(recorder.elapsed);
    $('rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  recTimer = setInterval(tick, 500);
  setStatus(`Recording → ${recorder.name}`, 'rec');
}

async function stopRecording() {
  if (!recorder.recording) return;
  clearInterval(recTimer);
  $('rec-badge').hidden = true;
  $('shutter').classList.remove('recording');
  $('mode').disabled = false;
  updateMode();
  const result = await recorder.stop();
  if (result?.blob) setThumb(result.blob, capCanvas);
  if (result) flash(recorder.writeError ? `Recording failed: ${recorder.writeError.message}` : `Saved ${result.name}`,
    recorder.writeError ? 'error' : 'live');
}

recorder.onerror = () => stopRecording(); // stopRecording reports the error

const toggleRecording = () => (recorder.recording ? stopRecording() : startRecording());

function updateMode() {
  const shutter = $('shutter');
  shutter.classList.toggle('video', videoMode);
  shutter.ariaLabel = videoMode ? 'Start recording' : 'Take photo';
  const mode = $('mode');
  mode.ariaLabel = videoMode ? 'Switch to photo' : 'Switch to video';
  mode.querySelector('use').setAttribute('href', videoMode ? '#i-camera' : '#i-video');
}

// On phones one sheet replaces the bottom controls at a time; on wide screens CSS shows them all in the sidebar.
function openSheet(name) {
  if (name !== 'adjust') imageUI.close(); // its slider floats over the picture only while the sheet is open
  if (name) $('bottom').dataset.open = name;
  else delete $('bottom').dataset.open;
  camUI.update();
}
// Matches the sidebar breakpoint in style.css, where every sheet is always showing.
const wide = matchMedia('(min-width: 900px)');
const sheetShown = (name) => wide.matches || $('bottom').dataset.open === name;
for (const b of document.querySelectorAll('[data-sheet]')) b.onclick = () => openSheet(b.dataset.sheet);
for (const b of document.querySelectorAll('.sheet .collapse')) b.onclick = () => openSheet(null);

const swatches = PALETTES.map((p, i) => {
  const stops = [];
  for (let k = 0; k <= 8; k++) {
    const v = Math.round(255 - (k * 255) / 8) * 3;
    stops.push(`rgb(${p.lut[v]},${p.lut[v + 1]},${p.lut[v + 2]})`);
  }
  const b = document.createElement('button');
  b.className = 'opt swatch';
  b.innerHTML = `<span class="tile"><b style="background:linear-gradient(${stops.join(',')})"></b></span>`;
  b.append(p.name);
  b.onclick = () => { view.palette = i; updatePalette(); queueDraw(); };
  $('palettes').append(b);
  return b;
});
function updatePalette() {
  swatches.forEach((b, i) => b.classList.toggle('active', i === view.palette));
}

const toggles = {
  center: { get: () => view.showCenter, set: (v) => { view.showCenter = v; } },
  max: { get: () => view.showMax, set: (v) => { view.showMax = v; } },
  min: { get: () => view.showMin, set: (v) => { view.showMin = v; } },
};
function updateToggles() {
  for (const b of document.querySelectorAll('[data-toggle]')) b.classList.toggle('active', toggles[b.dataset.toggle].get());
}
for (const b of document.querySelectorAll('[data-toggle]')) {
  b.onclick = () => { const t = toggles[b.dataset.toggle]; t.set(!t.get()); updateToggles(); queueDraw(); };
}

function updateMarkers() {
  $('save-markers').classList.toggle('on', output.markers);
  $('save-markers').ariaPressed = String(output.markers);
}
$('save-markers').onclick = () => { output.markers = !output.markers; saveOutput(); updateMarkers(); };

function updateProbeToggle() {
  $('probe-toggle').ariaPressed = String(probeOn);
  $('probe-state').textContent = probeOn ? 'On' : 'Off';
  if (!probeOn && latest) $('r-probe').textContent = 'Off';
}
$('probe-toggle').onclick = () => {
  probeOn = !probeOn;
  if (!probeOn) view.probe = null;
  updateProbeToggle();
  queueDraw();
};

const measure = setupMeasure(view, { queueDraw, probe: { enabled: () => probeOn } });
const camUI = setupCamera({ view, vis, queueDraw, flash, camera: () => cam, sheetShown: () => sheetShown('camera') });
const imageUI = setupImage({ view, queueDraw, live: () => !!cam && !!view.image, detailChanged: () => camUI.refresh() });
const sceneUI = setupScene({ view, measureUI: measure, queueDraw });
vis.onframe = queueDraw;

const actions = {
  palette: () => { view.nextPalette(); updatePalette(); queueDraw(); },
  rotate: () => { view.rotate(); imageUI.update(); queueDraw(); },
  mirror: () => { view.toggleMirror(); imageUI.update(); queueDraw(); },
  flipV: () => { view.flipVertical(); imageUI.update(); queueDraw(); },
  calibrate,
  picture: () => camUI.nextMode(),
  photo: takePhoto,
  video: toggleRecording,
  saveCSV: () => cam && view.image && saveCSV(view.image),
};

$('connect').onclick = onConnectClick;
$('connect-big').onclick = onConnectClick;
$('menu').onclick = () => $('help').showModal();
$('help-link').onclick = showSetupHelp;
$('help-close').onclick = () => $('help').close();
$('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); });
$('ffc').onclick = actions.calibrate;
$('rotate').onclick = actions.rotate;
$('flip-h').onclick = actions.mirror;
$('flip-v').onclick = actions.flipV;
$('save-png').onclick = actions.photo;
$('save-csv').onclick = actions.saveCSV;
$('shutter').onclick = () => (videoMode || recorder.recording ? toggleRecording() : takePhoto());
$('mode').onclick = () => { videoMode = !videoMode; updateMode(); };
$('thumb').onclick = () => lastCaptureUrl && window.open(lastCaptureUrl, '_blank');

const keys = {
  p: actions.palette, i: actions.picture, r: actions.rotate, m: actions.mirror, f: actions.calibrate,
  s: actions.photo, v: actions.video, c: actions.saveCSV,
  delete: measure.removeSelected, backspace: measure.removeSelected, escape: measure.cancel,
};
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, select, textarea')) return;
  if (camUI.alignKey(e)) return e.preventDefault();
  const action = keys[e.key.toLowerCase()];
  if (action) { action(); if (e.key === 'Backspace') e.preventDefault(); }
});

window.addEventListener('resize', queueDraw);

// Horizontal rows (tool tiles, palettes, measurement chips) hide their scrollbar, so let a mouse scroll
// them too: the wheel scrolls sideways and click-dragging pans. A drag doesn't count as a click.
function mouseScroll(el) {
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, { passive: false });
  let start = null, dragged = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button) return;
    start = { x: e.clientX, left: el.scrollLeft };
    dragged = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || el.scrollWidth <= el.clientWidth) return;
    const dx = e.clientX - start.x;
    if (!dragged && Math.abs(dx) < 5) return;
    if (!dragged) { dragged = true; el.setPointerCapture(e.pointerId); el.classList.add('dragging'); }
    el.scrollLeft = start.left - dx;
  });
  const end = () => { start = null; el.classList.remove('dragging'); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
}
document.querySelectorAll('.options.scroll, .mlist').forEach(mouseScroll);

updatePalette();
updateMarkers();
updateToggles();
updateProbeToggle();
updateMode();
setLive(false);
setStatus('Not connected');

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
  $('connect').disabled = $('connect-big').disabled = true;
  setStatus('WebUSB not available', 'error');
} else {
  const isIX1 = (d) => d.vendorId === VID && d.productId === PID;
  navigator.usb.addEventListener('connect', (e) => { if (isIX1(e.device)) connect(e.device); });
  navigator.usb.addEventListener('disconnect', (e) => {
    if (!isIX1(e.device)) return;
    if (cam && e.device === cam.device) disconnect('Camera unplugged');
    else if (!cam) setStatus('Camera unplugged'); // the stream error may have got there first
  });
  IX1.paired().then((devices) => devices[0] && connect(devices[0]));
  window.addEventListener('pagehide', () => { recorder.recording && recorder.stop(); vis.use(null); cam?.close(); });
}
