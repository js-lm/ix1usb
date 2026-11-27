import {
  SCENES, HVAC_LIMIT, HVAC_FRAMES,
  INSULATION_DEFAULTS, INSULATION_PRESETS, checkInsulation, insulationIsotherm,
  DAMP_DEFAULTS, DAMP_PRESETS, checkDamp, dampIsotherm,
} from './scenes.js';
import { store } from './visible.js';

const ICONS = {
  standard: '<rect x="9.5" y="9.5" width="5" height="5"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
  hvac: '<path d="M8 3.5c-1.2 1.2 1.2 2.6 0 3.8M12 3.5c-1.2 1.2 1.2 2.6 0 3.8M16 3.5c-1.2 1.2 1.2 2.6 0 3.8"/><rect x="3.5" y="11" width="17" height="4" rx="2"/><rect x="3.5" y="17" width="17" height="4" rx="2"/>',
  insulation: '<path d="M4 4.5h16v15H4zM4 9.5h16M4 14.5h16M9 4.5v5M15 9.5v5M9 14.5v5"/>',
  damp: '<path d="M12 3.5c3 4 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.5z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
};

const HVAC_HINT = 'Drag R1 to the inlet pipe or side and R2 to the outlet. Resize them as needed.';

const f1 = (t) => t.toFixed(1);
const sign = (iso) => (iso.above ? '≥' : '≤');

/** Wires up the Scene sheet, the Insulation and Damp & Mold settings, and HVAC's frames.
 *  ctx: { view, measureUI, queueDraw }. */
export function setupScene({ view, measureUI, queueDraw }) {
  const $ = (id) => document.getElementById(id);
  const m = view.measure;
  const saved = store.get('ix1.scene', { scene: 'standard' });
  const state = {
    scene: saved.scene in SCENES ? saved.scene : 'standard',
    insulation: checkInsulation(saved.insulation) ? { ...INSULATION_DEFAULTS } : saved.insulation,
    damp: checkDamp(saved.damp) ? { ...DAMP_DEFAULTS } : saved.damp,
  };
  const save = () => store.set('ix1.scene', state);

  const isotherm = (scene = state.scene) =>
    scene === 'insulation' ? insulationIsotherm(state.insulation) : scene === 'damp' ? dampIsotherm(state.damp) : null;

  // ---- HVAC: its own measurements, R1 and R2 and their difference, swapped in for the user's ----
  let stash = null; // the user's measurements while HVAC is on
  let hvac = null; // HVAC's, kept while another scene is on

  function enterHvac() {
    stash = { items: m.items, diffs: m.diffs };
    m.items = hvac?.items ?? [];
    m.diffs = hvac?.diffs ?? [];
    m.selected = null;
    measureUI.setLocked(true);
    m.changed();
  }
  function leaveHvac() {
    hvac = { items: m.items, diffs: m.diffs };
    m.items = stash.items;
    m.diffs = stash.diffs;
    stash = null;
    m.selected = null;
    measureUI.setLocked(false);
  }
  /** Places R1 and R2 once there's a picture to place them on. */
  function placeHvacFrames() {
    if (state.scene !== 'hvac' || m.items.length || !view.image) return;
    const { width: W, height: H } = view.image;
    const [r1, r2] = HVAC_FRAMES.map(([x0, y0, x1, y1]) =>
      m.add('rect', { a: view.toSensor([x0 * W, y0 * H]), b: view.toSensor([x1 * W, y1 * H]) }));
    const d = m.addDiff({ ref: r1, metric: 'max' }, { ref: r2, metric: 'max' });
    r1.locked = r2.locked = d.locked = true;
    r1.maxOnly = r2.maxOnly = true; // only the hottest point matters, and the frames sit close together
    m.select(null);
  }
  const hvacExceeded = () => {
    const [a, b] = m.items;
    return state.scene === 'hvac' && !!a?.stats && !!b?.stats && Math.abs(a.stats.max - b.stats.max) > HVAC_LIMIT;
  };

  // ---- on the picture (saved photos and videos too) ----
  function pill(ctx, v, text, alert) {
    const fs = Math.round(v.unit * 0.75);
    const pad = Math.round(fs * 0.6), h = Math.round(fs * 1.7);
    ctx.save();
    ctx.font = `500 ${fs}px system-ui, sans-serif`;
    const w = Math.min(ctx.measureText(text).width + pad * 2, v.irW - pad * 2);
    const x = alert ? (v.irW - w) / 2 : pad, y = v.irH - pad - h;
    ctx.fillStyle = alert ? 'rgba(255,59,48,0.92)' : 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pad, y + h / 2, w - pad * 2);
    ctx.restore();
  }
  // Runs after drawItems, so R1's and R2's stats are this frame's.
  view.overlays.push((ctx, img, v) => {
    if (hvacExceeded()) pill(ctx, v, `Temperature difference > ${HVAC_LIMIT}°C`, true);
    const iso = v.isotherm;
    if (iso) pill(ctx, v, `${SCENES[state.scene]} · ${sign(iso)} ${f1(iso.threshold)}°C`, false);
  });

  // ---- sheet ----
  const tiles = Object.entries(SCENES).map(([scene, label]) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.dataset.scene = scene;
    b.innerHTML = `<span class="tile"><svg viewBox="0 0 24 24">${ICONS[scene]}</svg></span>`;
    b.append(label);
    b.onclick = () => setScene(scene, true);
    $('scenes').append(b);
    return b;
  });
  $('scene-settings').onclick = () => openSettings();

  function setScene(scene, user = false) {
    const prev = state.scene;
    if (scene !== prev) {
      if (prev === 'hvac') leaveHvac();
      state.scene = scene;
      if (scene === 'hvac') enterHvac();
      save();
      apply();
    }
    if (user && scene === 'hvac') toast(HVAC_HINT);
    if (user && (scene === 'insulation' || scene === 'damp')) openSettings();
  }

  function apply() {
    view.isotherm = isotherm();
    render();
    queueDraw();
  }

  function describe() {
    const { scene } = state;
    if (scene === 'hvac') return `R1 on the inlet, R2 on the outlet. Warns when their hottest points differ by more than ${HVAC_LIMIT}°C.`;
    if (scene === 'insulation') {
      const s = state.insulation, iso = isotherm();
      return `From the ${s.location}, ${f1(s.interior)}°C in and ${f1(s.exterior)}°C out, ${s.rate}% insulation: ` +
        `surfaces ${sign(iso)} ${f1(iso.threshold)}°C in colour.`;
    }
    if (scene === 'damp') {
      const s = state.damp, iso = isotherm();
      return `Air at ${f1(s.air)}°C and ${s.humidity}%: surfaces ≤ ${f1(iso.threshold)}°C reach ${s.baseline}% humidity and show in colour.`;
    }
    return 'The normal view and measurements.';
  }

  function render() {
    for (const b of tiles) b.classList.toggle('active', b.dataset.scene === state.scene);
    $('scene-info').textContent = describe();
    $('scene-settings').disabled = state.scene !== 'insulation' && state.scene !== 'damp';
  }

  let toastTimer = 0;
  function toast(text) {
    const el = $('scene-toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  // ---- settings dialog ----
  const dlg = $('scene-dlg');
  const form = $('scene-form');
  let editing = null;

  const presets = { 's-rate': INSULATION_PRESETS, 's-baseline': DAMP_PRESETS };
  for (const [id, list] of Object.entries(presets)) {
    const sel = $(`${id}-preset`);
    sel.add(new Option('Custom', ''));
    for (const [v, label] of list) sel.add(new Option(`${label}: ${v}%`, v));
    sel.onchange = () => { if (sel.value) $(id).value = sel.value; check(); };
  }

  const num = (id) => ($(id).value.trim() === '' ? NaN : Number($(id).value));
  function read() {
    return editing === 'insulation'
      ? { location: form.elements.loc.value, interior: num('s-interior'), exterior: num('s-exterior'), rate: num('s-rate') }
      : { humidity: num('s-humidity'), air: num('s-air'), baseline: num('s-baseline') };
  }

  /** Validates the form and shows the threshold it gives. */
  function check() {
    const s = read();
    const error = editing === 'insulation' ? checkInsulation(s) : checkDamp(s);
    for (const id of Object.keys(presets)) {
      const sel = $(`${id}-preset`);
      sel.value = presets[id].some(([v]) => v === num(id)) ? String(num(id)) : '';
    }
    $('scene-apply').disabled = !!error;
    const out = $('scene-result');
    out.classList.toggle('error', !!error);
    if (error) out.textContent = error;
    else {
      const iso = editing === 'insulation' ? insulationIsotherm(s) : dampIsotherm(s);
      out.textContent = `Surfaces ${iso.above ? 'at or above' : 'at or below'} ${f1(iso.threshold)}°C will show in colour, the rest in grey.`;
    }
  }

  function openSettings() {
    const scene = state.scene;
    if (scene !== 'insulation' && scene !== 'damp') return;
    editing = scene;
    for (const el of dlg.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== scene;
    $('scene-title').textContent = `${SCENES[scene]} settings`;
    if (scene === 'insulation') {
      const s = state.insulation;
      form.elements.loc.value = s.location;
      $('s-interior').value = s.interior;
      $('s-exterior').value = s.exterior;
      $('s-rate').value = s.rate;
    } else {
      const s = state.damp;
      $('s-humidity').value = s.humidity;
      $('s-air').value = s.air;
      $('s-baseline').value = s.baseline;
    }
    check();
    if (!dlg.open) dlg.showModal();
  }

  form.addEventListener('input', check);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = read();
    if (editing === 'insulation' ? checkInsulation(s) : checkDamp(s)) return;
    state[editing] = s;
    save();
    apply();
    dlg.close();
  });
  $('scene-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  // What a saved photo records about the scene.
  view.sceneMeta = () => {
    const meta = { name: SCENES[state.scene] };
    if (state.scene === 'hvac') meta.limit = HVAC_LIMIT;
    if (state.scene === 'insulation') meta.settings = { ...state.insulation };
    if (state.scene === 'damp') meta.settings = { ...state.damp };
    const iso = isotherm();
    if (iso) meta.highlight = { [iso.above ? 'atOrAbove' : 'atOrBelow']: Math.round(iso.threshold * 100) / 100 };
    return meta;
  };

  if (state.scene === 'hvac') enterHvac();
  apply();

  return {
    /** Call after every view.draw(). */
    update: placeHvacFrames,
  };
}
