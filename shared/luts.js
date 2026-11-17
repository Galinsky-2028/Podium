// Shared color-grading engine. Runs in the browser (live preview, WebGL 3D texture)
// and in Node (baked to a .cube file for ffmpeg's lut3d filter), so the preview and
// the export use exactly the same numbers.

export const LUT_SIZE = 33;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/*
 Look recipe fields (all optional):
   lift/gamma/gain: [r,g,b] ASC-CDL-ish wheels (lift adds, gain multiplies, gamma exponent)
   contrast: 0..1 S-curve strength (negative flattens)
   sat: saturation multiplier
   shadows/highs: [r,g,b] split-tone tint added to shadows / highlights
   mono: true for black & white, with optional monoTint [r,g,b]
   fade: lifts blacks (matte)
   crush: lowers highlights roll-off
   bleach: 0..1 bleach-bypass mix (desaturated luma overlay)
   orangeTeal: 0..1 push skin to orange, shadows to teal
*/
export const LOOKS = [
  { id: 'none', name: 'None', group: 'Basic', recipe: {} },
  { id: 'broadcast-clean', name: 'Broadcast Clean', group: 'Basic', recipe: { contrast: 0.12, sat: 1.05 } },
  { id: 'documentary-natural', name: 'Documentary Natural', group: 'Basic', recipe: { contrast: 0.08, sat: 0.95, gain: [1.01, 1, 0.98] } },
  { id: 'presidential-warm', name: 'Presidential Warm', group: 'Campaign', recipe: { contrast: 0.18, sat: 1.06, gain: [1.04, 1.0, 0.94], shadows: [0.0, 0.0, 0.015], highs: [0.02, 0.01, -0.01] } },
  { id: 'hopeful-morning', name: 'Hopeful Morning', group: 'Campaign', recipe: { contrast: 0.1, sat: 1.08, lift: [0.01, 0.01, 0.02], gain: [1.05, 1.02, 0.95], fade: 0.03 } },
  { id: 'americana-gold', name: 'Americana Gold', group: 'Campaign', recipe: { contrast: 0.22, sat: 1.12, gain: [1.08, 1.02, 0.88], shadows: [0.02, 0.0, -0.02] } },
  { id: 'serious-steel', name: 'Serious Steel', group: 'Campaign', recipe: { contrast: 0.28, sat: 0.8, gain: [0.96, 1.0, 1.05], shadows: [-0.01, 0.0, 0.02] } },
  { id: 'film-print-warm', name: 'Film Print Warm', group: 'Film', recipe: { contrast: 0.32, sat: 1.0, gamma: [0.97, 1.0, 1.05], gain: [1.04, 1.0, 0.93], shadows: [0.0, 0.01, 0.025], crush: 0.08 } },
  { id: 'film-print-neutral', name: 'Film Print Neutral', group: 'Film', recipe: { contrast: 0.3, sat: 0.95, shadows: [0.0, 0.008, 0.02], crush: 0.08 } },
  { id: 'film-soft-eterna', name: 'Film Soft Pastel', group: 'Film', recipe: { contrast: -0.05, sat: 0.78, lift: [0.02, 0.025, 0.03], gain: [0.98, 1.0, 0.98], fade: 0.04 } },
  { id: 'film-clean-reala', name: 'Film Clean', group: 'Film', recipe: { contrast: 0.15, sat: 0.92, gain: [1.0, 1.01, 0.99], highs: [0.0, 0.01, 0.0] } },
  { id: 'teal-orange', name: 'Teal & Orange', group: 'Cinematic', recipe: { contrast: 0.25, sat: 1.1, orangeTeal: 0.6 } },
  { id: 'bleach-bypass', name: 'Bleach Bypass', group: 'Cinematic', recipe: { contrast: 0.45, sat: 0.55, bleach: 0.55 } },
  { id: 'low-key-moody', name: 'Low Key Moody', group: 'Cinematic', recipe: { contrast: 0.35, sat: 0.85, gamma: [1.12, 1.12, 1.08], shadows: [0.0, 0.005, 0.02] } },
  { id: 'high-key-bright', name: 'High Key Bright', group: 'Cinematic', recipe: { contrast: -0.08, sat: 1.0, gamma: [0.85, 0.85, 0.87], fade: 0.02 } },
  { id: 'matte-fade', name: 'Matte Fade', group: 'Cinematic', recipe: { contrast: 0.05, sat: 0.85, fade: 0.09, crush: 0.06 } },
  { id: 'blue-cold', name: 'Blue Cold', group: 'Color', recipe: { contrast: 0.2, sat: 0.85, gain: [0.9, 0.98, 1.1], shadows: [-0.01, 0.0, 0.03] } },
  { id: 'blue-ice', name: 'Blue Ice', group: 'Color', recipe: { contrast: 0.12, sat: 0.6, gain: [0.92, 1.0, 1.08], lift: [0.0, 0.015, 0.035] } },
  { id: 'day-for-night', name: 'Blue Day-for-Night', group: 'Color', recipe: { contrast: 0.3, sat: 0.55, gain: [0.6, 0.72, 0.95], gamma: [1.25, 1.2, 1.05] } },
  { id: 'golden-hour', name: 'Golden Hour', group: 'Color', recipe: { contrast: 0.18, sat: 1.15, gain: [1.1, 1.0, 0.82], highs: [0.03, 0.015, -0.02] } },
  { id: 'green-tint', name: 'Green Tint', group: 'Color', recipe: { contrast: 0.22, sat: 0.85, gain: [0.94, 1.05, 0.92], shadows: [0.0, 0.02, 0.0] } },
  { id: 'vintage-70s', name: 'Vintage 70s', group: 'Color', recipe: { contrast: 0.1, sat: 0.9, fade: 0.07, gain: [1.08, 1.02, 0.85], shadows: [0.02, 0.01, -0.02] } },
  { id: 'cross-process', name: 'Cross Process', group: 'Color', recipe: { contrast: 0.35, sat: 1.2, gamma: [0.92, 0.95, 1.15], lift: [0.0, 0.0, 0.06], gain: [1.05, 1.06, 0.85] } },
  { id: 'mono-film', name: 'Monochrome Film', group: 'Monochrome', recipe: { mono: true, contrast: 0.3, crush: 0.05 } },
  { id: 'mono-high-contrast', name: 'Monochrome High Contrast', group: 'Monochrome', recipe: { mono: true, contrast: 0.6 } },
  { id: 'mono-soft', name: 'Monochrome Soft', group: 'Monochrome', recipe: { mono: true, contrast: 0.05, fade: 0.06 } },
  { id: 'sepia', name: 'Sepia', group: 'Monochrome', recipe: { mono: true, monoTint: [1.07, 0.98, 0.82], contrast: 0.15, fade: 0.03 } },
];

export const LOOK_IDS = LOOKS.map((l) => l.id);

// User "knobs" applied on top of the look (like Lumetri Basic Correction).
export const KNOBS = [
  { key: 'intensity', label: 'Look intensity', min: 0, max: 200, step: 1, def: 100, unit: '%' },
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, def: 0 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, def: 0 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, def: 0 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, def: 0 },
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1, def: 0 },
  { key: 'tint', label: 'Tint', min: -100, max: 100, step: 1, def: 0 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1, def: 100, unit: '%' },
  { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, def: 0 },
  { key: 'fade', label: 'Faded film', min: 0, max: 100, step: 1, def: 0 },
];

export const defaultGrade = (look = 'presidential-warm') => ({
  look,
  ...Object.fromEntries(KNOBS.map((k) => [k.key, k.def])),
});

function applyRecipe(r, g, b, R) {
  if (R.lift) { r += R.lift[0]; g += R.lift[1]; b += R.lift[2]; }
  if (R.gain) { r *= R.gain[0]; g *= R.gain[1]; b *= R.gain[2]; }
  if (R.gamma) {
    r = Math.pow(clamp01(r), R.gamma[0]);
    g = Math.pow(clamp01(g), R.gamma[1]);
    b = Math.pow(clamp01(b), R.gamma[2]);
  }
  if (R.orangeTeal) {
    const l = luma(r, g, b);
    const t = R.orangeTeal;
    const sh = 1 - smooth(0.15, 0.6, l);
    const hi = smooth(0.35, 0.85, l);
    r += t * (0.06 * hi - 0.05 * sh);
    g += t * (0.015 * hi + 0.02 * sh);
    b += t * (-0.07 * hi + 0.06 * sh);
  }
  if (R.shadows || R.highs) {
    const l = luma(r, g, b);
    const sh = 1 - smooth(0.0, 0.55, l);
    const hi = smooth(0.45, 1.0, l);
    if (R.shadows) { r += R.shadows[0] * sh * 2; g += R.shadows[1] * sh * 2; b += R.shadows[2] * sh * 2; }
    if (R.highs) { r += R.highs[0] * hi * 2; g += R.highs[1] * hi * 2; b += R.highs[2] * hi * 2; }
  }
  if (R.contrast) {
    const k = R.contrast;
    const f = (x) => {
      x = clamp01(x);
      const s = x * x * (3 - 2 * x);
      return k >= 0 ? lerp(x, s, Math.min(1, k * 1.6)) : lerp(x, 0.5 + (x - 0.5) * 0.7, Math.min(1, -k * 2));
    };
    r = f(r); g = f(g); b = f(b);
  }
  if (R.bleach) {
    const l = luma(r, g, b);
    const ov = (base, blend) => (base < 0.5 ? 2 * base * blend : 1 - 2 * (1 - base) * (1 - blend));
    r = lerp(r, ov(r, l), R.bleach); g = lerp(g, ov(g, l), R.bleach); b = lerp(b, ov(b, l), R.bleach);
  }
  if (R.mono) {
    const l = luma(r, g, b);
    const t = R.monoTint || [1, 1, 1];
    r = l * t[0]; g = l * t[1]; b = l * t[2];
  } else if (R.sat !== undefined && R.sat !== 1) {
    const l = luma(r, g, b);
    r = l + (r - l) * R.sat; g = l + (g - l) * R.sat; b = l + (b - l) * R.sat;
  }
  if (R.crush) {
    const c = (x) => (x > 0.75 ? 0.75 + (x - 0.75) * (1 - R.crush * 2) : x);
    r = c(r); g = c(g); b = c(b);
  }
  if (R.fade) {
    r = R.fade + r * (1 - R.fade); g = R.fade + g * (1 - R.fade); b = R.fade + b * (1 - R.fade);
  }
  return [r, g, b];
}

function applyKnobs(r, g, b, k) {
  if (k.exposure) { const m = Math.pow(2, k.exposure); r *= m; g *= m; b *= m; }
  if (k.temperature) { const t = k.temperature / 100; r *= 1 + 0.12 * t; b *= 1 - 0.12 * t; g *= 1 + 0.02 * t; }
  if (k.tint) { const t = k.tint / 100; g *= 1 - 0.1 * t; r *= 1 + 0.04 * t; b *= 1 + 0.04 * t; }
  if (k.highlights || k.shadows) {
    const l = clamp01(luma(r, g, b));
    const hi = smooth(0.4, 1.0, l), sh = 1 - smooth(0.0, 0.6, l);
    const d = (k.highlights / 100) * 0.25 * hi + (k.shadows / 100) * 0.25 * sh;
    r += d; g += d; b += d;
  }
  if (k.contrast) {
    const c = k.contrast / 100;
    const f = (x) => {
      x = clamp01(x);
      const s = x * x * (3 - 2 * x);
      return c >= 0 ? lerp(x, s, c) : lerp(x, 0.5 + (x - 0.5) * 0.6, -c);
    };
    r = f(r); g = f(g); b = f(b);
  }
  const satM = (k.saturation ?? 100) / 100;
  if (satM !== 1 || k.vibrance) {
    const l = luma(r, g, b);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const curSat = mx - mn;
    const vib = 1 + (k.vibrance / 100 || 0) * (1 - clamp01(curSat * 1.5));
    const s = satM * vib;
    r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
  }
  if (k.fade) { const f = (k.fade / 100) * 0.15; r = f + r * (1 - f); g = f + g * (1 - f); b = f + b * (1 - f); }
  return [r, g, b];
}

// Trilinear sample of a custom LUT table (Float32Array, size^3*3, r fastest).
function sampleTable(tbl, size, r, g, b) {
  const s = size - 1;
  const fx = clamp01(r) * s, fy = clamp01(g) * s, fz = clamp01(b) * s;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const x1 = Math.min(s, x0 + 1), y1 = Math.min(s, y0 + 1), z1 = Math.min(s, z0 + 1);
  const dx = fx - x0, dy = fy - y0, dz = fz - z0;
  const at = (x, y, z, c) => tbl[(x + y * size + z * size * size) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = lerp(at(x0, y0, z0, c), at(x1, y0, z0, c), dx);
    const c10 = lerp(at(x0, y1, z0, c), at(x1, y1, z0, c), dx);
    const c01 = lerp(at(x0, y0, z1, c), at(x1, y0, z1, c), dx);
    const c11 = lerp(at(x0, y1, z1, c), at(x1, y1, z1, c), dx);
    out[c] = lerp(lerp(c00, c10, dy), lerp(c01, c11, dy), dz);
  }
  return out;
}

/**
 * Bake a grade into a LUT table.
 * @param grade {look, intensity, exposure, ...}
 * @param customLuts map id -> {size, table:Float32Array|number[]} for uploaded .cube looks
 * @returns Float32Array length size^3*3, red fastest (cube file order)
 */
export function bakeGrade(grade, customLuts = {}, size = LUT_SIZE) {
  const g0 = { ...defaultGrade('none'), ...(grade || {}) };
  const look = LOOKS.find((l) => l.id === g0.look);
  const custom = !look && customLuts[g0.look];
  const recipe = look ? look.recipe : {};
  const inten = (g0.intensity ?? 100) / 100;
  const out = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r0 = x / (size - 1), gg = y / (size - 1), b0 = z / (size - 1);
        let L = custom ? sampleTable(custom.table, custom.size, r0, gg, b0) : applyRecipe(r0, gg, b0, recipe);
        // intensity: mix (and extrapolate up to 200%) between source and look
        let r = r0 + (L[0] - r0) * inten, g = gg + (L[1] - gg) * inten, b = b0 + (L[2] - b0) * inten;
        [r, g, b] = applyKnobs(r, g, b, g0);
        out[i++] = clamp01(r); out[i++] = clamp01(g); out[i++] = clamp01(b);
      }
    }
  }
  return out;
}

export function toCube(table, size = LUT_SIZE, title = 'Podium grade') {
  const lines = [`TITLE "${title.replace(/"/g, '')}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < table.length; i += 3) {
    lines.push(`${table[i].toFixed(6)} ${table[i + 1].toFixed(6)} ${table[i + 2].toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

// Parse an uploaded .cube (e.g. the Lumetri LUT files that ship with Premiere Pro).
export function parseCube(text) {
  let size = 0;
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^LUT_3D_SIZE/i.test(line)) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error('1D LUTs are not supported; please upload a 3D .cube');
    if (/^DOMAIN_MIN/i.test(line)) { dmin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^DOMAIN_MAX/i.test(line)) { dmax = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Za-z]/.test(line)) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((n) => Number.isFinite(n))) vals.push(p[0], p[1], p[2]);
  }
  if (!size || vals.length !== size * size * size * 3) throw new Error('Invalid .cube file (size/data mismatch)');
  const table = new Float32Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const c = i % 3;
    table[i] = (vals[i] - dmin[c]) / ((dmax[c] - dmin[c]) || 1);
  }
  return { size, table };
}
