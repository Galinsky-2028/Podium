import { q, one } from './db.js';

const SECRET_KEYS = ['anthropicKey', 'heygenKey', 'xaiKey'];
const ENV_FOR = { anthropicKey: 'ANTHROPIC_API_KEY', heygenKey: 'HEYGEN_API_KEY', xaiKey: 'XAI_API_KEY' };

export const DEFAULT_SETTINGS = {
  anthropicKey: '',
  heygenKey: '',
  xaiKey: '',
  claudeModel: 'claude-opus-5-5',
  candidateName: '',
  candidateTitle: '',
  voiceNotes:
    'Plain-spoken, warm, specific. Short sentences that are easy to say on camera. Concrete examples over abstractions. End with a clear call to action.',
  heygen: {
    voiceId: '',
    width: 1920,
    height: 1080,
    speed: 1.0,
    looks: [
      // { key: 'podium', label: 'At the podium (medium shot)', avatarId: '', avatarType: 'avatar', description: '' }
    ],
  },
  grok: {
    model: 'grok-imagine-video',
    resolution: '720p',
    aspectRatio: '16:9',
    styleSuffix:
      'Photorealistic documentary footage, natural light, cinematic 16:9, shallow depth of field, no on-screen text, no logos, no recognizable real people.',
  },
  defaults: { lengthMinutes: 2, look: 'presidential-warm', brollShare: 35, autoExport: false },
};

let cache = null;
export async function getSettings() {
  if (cache) return cache;
  const row = await one("SELECT value FROM settings WHERE key='config'");
  const v = row ? row.value : {};
  cache = deepMerge(structuredClone(DEFAULT_SETTINGS), v);
  for (const k of SECRET_KEYS) if (!cache[k] && process.env[ENV_FOR[k]]) cache[k] = process.env[ENV_FOR[k]];
  return cache;
}

export async function saveSettings(patch) {
  const cur = (await one("SELECT value FROM settings WHERE key='config'"))?.value || {};
  for (const k of SECRET_KEYS) {
    // masked values coming back from the UI mean "unchanged"
    if (typeof patch[k] === 'string' && patch[k].includes('•')) delete patch[k];
  }
  const next = deepMerge(cur, patch);
  await q(
    "INSERT INTO settings(key, value) VALUES ('config', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
    [next],
  );
  cache = null;
  return getSettings();
}

export function publicSettings(s) {
  const out = structuredClone(s);
  for (const k of SECRET_KEYS) {
    const v = s[k] || '';
    out[k] = v ? `${'•'.repeat(8)}${v.slice(-4)}` : '';
    out[`${k}Set`] = !!v;
  }
  return out;
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}
