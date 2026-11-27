// Inspection scenes, worked out from TI Studio (com.ir.tas_base.vm.usb.*InspectionVM). No DOM here.
//
// - HVAC: two frames, R1 on the inlet side and R2 on the outlet. Warns when their hottest points differ
//   by more than HVAC_LIMIT.
// - Insulation and Damp & Mold: a threshold temperature is worked out from a few readings the user types
//   in. Pixels past it keep the palette's colours and the rest of the picture turns grey (an isotherm).

export const SCENES = {
  standard: 'Standard',
  hvac: 'HVAC',
  insulation: 'Insulation',
  damp: 'Damp & Mold',
};

/** °C between R1's and R2's hottest points before HVAC warns. */
export const HVAC_LIMIT = 6;

/** HVAC's frames as fractions of the displayed picture: [x0, y0, x1, y1]. */
export const HVAC_FRAMES = [[0.25, 0.44, 0.45, 0.6], [0.55, 0.44, 0.75, 0.6]];

// ---- Insulation ----

/** location: which side of the wall the camera is on. rate: thermal insulation rate, %. */
export const INSULATION_DEFAULTS = { location: 'interior', interior: 20, exterior: 10, rate: 50 };

/** [rate %, description]. These are the energy savings China's successive residential building standards
 *  aimed for (TI Studio: "1st-generation energy-saving residential buildings (c. 1995–2000)" and so on). */
export const INSULATION_PRESETS = [
  [30, '1st-gen energy-saving, c. 1995–2000'],
  [50, '2nd-gen energy-saving, c. 2000–2010'],
  [65, '3rd-gen energy-saving, c. 2010–2018'],
  [75, '4th-gen energy-saving, 2018 on'],
];

/** An error message, or '' if the settings are usable. */
export function checkInsulation(s) {
  if (!s || (s.location !== 'interior' && s.location !== 'exterior')) return 'Choose interior or exterior';
  for (const t of [s.interior, s.exterior]) {
    if (!Number.isFinite(t) || t < -20 || t > 80) return 'Temperatures must be from −20 to 80°C';
  }
  if (s.interior === s.exterior) return "Interior and exterior temperatures can't be the same";
  if (!Number.isInteger(s.rate) || s.rate < 0 || s.rate > 100) return 'Insulation rate must be a whole number from 0 to 100';
  return '';
}

/** { threshold °C, above }: highlight pixels at or above the threshold if `above`, else at or below.
 *  The threshold sits between the two air temperatures, (100 − rate)% of the way from exterior to interior.
 *  The highlighted side is the one heat leaks towards: from inside in winter, cold patches; from outside
 *  in winter, warm ones; and the other way round when it's hotter outside. Same as TI Studio. */
export function insulationIsotherm(s) {
  const threshold = s.exterior + (s.interior - s.exterior) * (1 - s.rate / 100);
  const above = s.location === 'exterior' ? s.interior >= s.exterior : s.interior < s.exterior;
  return { threshold, above };
}

// ---- Damp & Mold ----

/** humidity: the room's relative humidity, %; air: its temperature, °C; baseline: the relative humidity
 *  at a surface above which mould can grow, %. */
export const DAMP_DEFAULTS = { humidity: 50, air: 25, baseline: 60 };

/** [baseline %, where it fits]. */
export const DAMP_PRESETS = [
  [40, 'Dry areas / heated rooms in winter'],
  [60, 'General office / residential'],
  [70, 'Basement / bathroom / AC vent'],
  [55, 'Equipment room / server room'],
];

export function checkDamp(s) {
  if (!s) return 'Missing settings';
  if (!Number.isFinite(s.humidity) || s.humidity < 1 || s.humidity > 100) return 'Relative humidity must be from 1 to 100%';
  if (!Number.isFinite(s.air) || s.air < -20 || s.air > 50) return 'Air temperature must be from −20 to 50°C';
  if (!Number.isInteger(s.baseline) || s.baseline < 1 || s.baseline > 100) return 'Humidity baseline must be a whole number from 1 to 100';
  return '';
}

// Magnus formula for saturation vapour pressure over water.
const MAGNUS_A = 17.27;
const MAGNUS_B = 237.3;

/** The surface temperature at which the room's air, cooled against it, reaches `baseline`% relative
 *  humidity. At baseline 100 it's the dew point. Surfaces at or below it are highlighted. */
export function dampIsotherm(s) {
  const g = (MAGNUS_A * s.air) / (MAGNUS_B + s.air) + Math.log(s.humidity / s.baseline);
  return { threshold: (MAGNUS_B * g) / (MAGNUS_A - g), above: false };
}
