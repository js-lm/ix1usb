import { store } from './visible.js';

const DEFAULTS = { brightness: 50, contrast: 50, detail: false, detailLevel: 50 };
const LABELS = { brightness: 'Brightness', contrast: 'Contrast', detail: 'Detail' };
/** The view property each tile's slider sets. */
const PROP = { brightness: 'brightness', contrast: 'contrast', detail: 'detailLevel' };

/** Wires up the Image sheet's brightness, contrast and detail tiles and its Reset all button. Brightness and
 *  contrast show their slider over the picture; Detail switches the visible camera's outlines on and off.
 *  ctx: { view, queueDraw, live(): boolean, detailChanged() }. */
export function setupImage({ view, queueDraw, live, detailChanged }) {
  const $ = (id) => document.getElementById(id);
  const saved = store.get('ix1.image', DEFAULTS);
  // Detail used to be one of the camera modes.
  const picture = store.get('ix1.picture', {});
  const migrated = picture.mode === 'detail';
  if (migrated) saved.detail = true;
  for (const k of Object.keys(DEFAULTS)) view[k] = saved[k];
  const save = () => store.set('ix1.image', Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, view[k]])));
  if (migrated) {
    store.set('ix1.picture', { ...picture, mode: 'ir' });
    save();
  }

  /** Which tile's slider is showing, or null. */
  let active = null;
  const tiles = [...document.querySelectorAll('[data-level]')];
  const bar = $('image-bar'), slider = $('image-level');

  for (const b of tiles) {
    b.onclick = () => {
      const name = b.dataset.level;
      if (name !== 'detail') {
        active = active === name ? null : name;
      } else {
        // Every tap switches it; its slider shows while it's on.
        view.detail = !view.detail;
        if (view.detail) active = 'detail';
        else if (active === 'detail') active = null;
        save();
        detailChanged();
      }
      render();
      queueDraw();
    };
  }
  slider.oninput = () => {
    view[PROP[active]] = Number(slider.value);
    render();
    queueDraw();
  };
  slider.onchange = save;
  // Puts everything in the Image sheet back: flip, rotation, brightness, contrast and detail.
  const isDefault = () => view.rotation === 1 && !view.mirror
    && Object.keys(DEFAULTS).every((k) => view[k] === DEFAULTS[k]);
  $('image-reset').onclick = () => {
    const hadDetail = view.detail;
    view.rotation = 1;
    view.mirror = false;
    view.probe = null;
    Object.assign(view, DEFAULTS);
    active = null;
    save();
    if (hadDetail) detailChanged();
    render();
    queueDraw();
  };

  function render() {
    for (const b of tiles) {
      b.classList.toggle('active', b.dataset.level === active);
      if (b.dataset.level === 'detail') b.classList.toggle('on', view.detail);
    }
    if (active) {
      $('image-label').textContent = LABELS[active];
      slider.value = view[PROP[active]];
      $('image-val').textContent = slider.value;
    }
    place();
  }

  function place() {
    $('image-reset').disabled = isDefault();
    const on = !!active && live() && !view.aligning;
    if (bar.hidden === on) bar.hidden = !on;
  }

  render();

  return {
    update: place,
    /** Hides the slider; called when the sheet closes on a phone. */
    close() {
      active = null;
      render();
    },
  };
}
