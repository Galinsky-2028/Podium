import { q } from './db.js';
import { parseCube, LUT_SIZE } from '../shared/luts.js';

let cache = null;
export async function loadCustomLuts() {
  if (cache) return cache;
  const rows = (await q('SELECT id, name, size, data FROM custom_luts ORDER BY created_at')).rows;
  cache = Object.fromEntries(rows.map((r) => [r.id, { id: r.id, name: r.name, size: r.size, table: Float32Array.from(r.data) }]));
  return cache;
}

export async function addCustomLut(name, text) {
  const { size, table } = parseCube(text);
  if (size > 65) throw new Error('LUT too large (max 65 points per axis)');
  const id = `custom-${name.toLowerCase().replace(/\.cube$/i, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`;
  // round to keep JSON compact
  const data = Array.from(table, (v) => Math.round(v * 1e5) / 1e5);
  await q('INSERT INTO custom_luts (id, name, size, data) VALUES ($1,$2,$3,$4)', [id, name.replace(/\.cube$/i, ''), size, JSON.stringify(data)]);
  cache = null;
  return { id, name, size };
}

export async function deleteCustomLut(id) {
  await q('DELETE FROM custom_luts WHERE id=$1', [id]);
  cache = null;
}

export { LUT_SIZE };
