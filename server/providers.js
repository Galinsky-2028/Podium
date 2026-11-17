// Video providers. Each exposes submit(input, settings) -> jobId and poll(jobId, settings)
// -> {state: 'processing'|'done'|'failed', url?, error?}. Responses are parsed defensively
// because both APIs have shipped several response shapes.

const HEYGEN = 'https://api.heygen.com';
const XAI = 'https://api.x.ai/v1';

async function http(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.error || text.slice(0, 400);
    const err = new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

// ---------- HeyGen (candidate on camera) ----------
export const heygen = {
  name: 'heygen',
  configured: (s) => !!(s.heygenKey && s.heygen.voiceId && (s.heygen.looks || []).some((l) => l.avatarId)),
  async submit(input, s) {
    const looks = (s.heygen.looks || []).filter((l) => l.avatarId);
    const look = looks.find((l) => l.key === input.look) || looks[0];
    const character = look.avatarType === 'talking_photo'
      ? { type: 'talking_photo', talking_photo_id: look.avatarId }
      : { type: 'avatar', avatar_id: look.avatarId, avatar_style: 'normal' };
    const body = {
      video_inputs: [{
        character,
        voice: { type: 'text', input_text: input.text, voice_id: look.voiceId || s.heygen.voiceId, speed: Number(s.heygen.speed) || 1 },
      }],
      dimension: { width: Number(s.heygen.width) || 1920, height: Number(s.heygen.height) || 1080 },
      title: (input.title || 'Podium clip').slice(0, 80),
    };
    const j = await http(`${HEYGEN}/v2/video/generate`, { method: 'POST', headers: { 'X-Api-Key': s.heygenKey }, body });
    const id = j?.data?.video_id || j?.video_id;
    if (!id) throw new Error(`HeyGen returned no video_id: ${JSON.stringify(j).slice(0, 300)}`);
    return id;
  },
  async poll(id, s) {
    const j = await http(`${HEYGEN}/v1/video_status.get?video_id=${encodeURIComponent(id)}`, { headers: { 'X-Api-Key': s.heygenKey } });
    const d = j.data || j;
    const st = String(d.status || '').toLowerCase();
    if (st === 'completed' && d.video_url) return { state: 'done', url: d.video_url, duration: d.duration };
    if (st === 'failed') return { state: 'failed', error: d.error?.message || d.error?.detail || JSON.stringify(d.error || 'HeyGen render failed') };
    return { state: 'processing' };
  },
  async listAvatars(s) {
    const j = await http(`${HEYGEN}/v2/avatars`, { headers: { 'X-Api-Key': s.heygenKey } });
    const d = j.data || {};
    return {
      avatars: (d.avatars || []).map((a) => ({ id: a.avatar_id, name: a.avatar_name, type: 'avatar', preview: a.preview_image_url })),
      talkingPhotos: (d.talking_photos || []).map((a) => ({ id: a.talking_photo_id, name: a.talking_photo_name, type: 'talking_photo', preview: a.preview_image_url })),
    };
  },
  async listVoices(s) {
    const j = await http(`${HEYGEN}/v2/voices`, { headers: { 'X-Api-Key': s.heygenKey } });
    return (j.data?.voices || []).map((v) => ({ id: v.voice_id, name: v.name, language: v.language, gender: v.gender }));
  },
};

// ---------- xAI Grok Imagine (b-roll) ----------
export const grok = {
  name: 'grok',
  configured: (s) => !!s.xaiKey,
  async submit(input, s) {
    const prompt = [input.prompt, s.grok.styleSuffix].filter(Boolean).join(' ');
    const body = {
      model: s.grok.model || 'grok-imagine-video',
      prompt,
      duration: Math.max(1, Math.min(15, Math.round(input.duration || 6))),
      aspect_ratio: s.grok.aspectRatio || '16:9',
      resolution: s.grok.resolution || '720p',
    };
    if (input.imageUrl) body.image = { url: input.imageUrl };
    const j = await http(`${XAI}/videos/generations`, { method: 'POST', headers: { Authorization: `Bearer ${s.xaiKey}` }, body });
    const id = j.request_id || j.id || j.data?.id;
    if (!id) {
      const url = j.video?.url || j.data?.[0]?.url || j.url;
      if (url) return `direct:${url}`;
      throw new Error(`Grok returned no request id: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return id;
  },
  async poll(id, s) {
    if (id.startsWith('direct:')) return { state: 'done', url: id.slice(7) };
    const j = await http(`${XAI}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${s.xaiKey}` } });
    const st = String(j.status || j.state || '').toLowerCase();
    const url = j.video?.url || j.url || j.data?.[0]?.url || j.result?.video?.url;
    if (url && (!st || ['done', 'completed', 'succeeded', 'success'].includes(st))) return { state: 'done', url, duration: j.video?.duration };
    if (['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(st)) return { state: 'failed', error: j.error?.message || j.error || `Grok status: ${st}` };
    return { state: 'processing' };
  },
};
