import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { q, one } from './db.js';
import { getSettings } from './settings.js';
import { heygen, grok } from './providers.js';
import { normalize, thumbnail, placeholderClip } from './ffmpeg.js';
import { putFile, WORK_DIR } from './storage.js';
import { estimateSpeechSeconds } from '../shared/timeline.js';
import { runExport } from './export.js';

const PROVIDERS = { heygen, grok };
const MAX_ATTEMPTS = 3;
let ingesting = 0;
const MAX_INGEST = Number(process.env.MAX_INGEST || 2);
const busy = new Set();

export function pickProvider(kind, s) {
  if (kind === 'aroll') return heygen.configured(s) ? 'heygen' : 'mock';
  return grok.configured(s) ? 'grok' : 'mock';
}

export async function createClip(projectId, shot, s, { provider } = {}) {
  const kind = shot.type;
  const prov = provider || pickProvider(kind, s);
  const input = kind === 'aroll'
    ? { text: shot.text, look: shot.look, title: shot.description }
    : { prompt: shot.prompt, duration: Math.min(15, Math.max(3, Math.ceil((shot.duration || 5) + (shot.fadeOut || 0.5) + 1))), description: shot.description };
  return one(
    `INSERT INTO clips (project_id, shot_id, kind, provider, input, status) VALUES ($1,$2,$3,$4,$5,'queued') RETURNING *`,
    [projectId, shot.id, kind, prov, input],
  );
}

const setClip = (id, fields) => {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  return q(`UPDATE clips SET ${sets}, updated_at=now() WHERE id=$1`, [id, ...keys.map((k) => fields[k])]);
};

async function fail(clip, err) {
  const attempts = clip.attempts + 1;
  const msg = String(err?.message || err).slice(0, 1000);
  const retryable = !(err?.status >= 400 && err?.status < 500 && err?.status !== 429);
  if (attempts >= MAX_ATTEMPTS || !retryable) {
    await setClip(clip.id, { status: 'failed', error: msg, attempts });
  } else {
    await setClip(clip.id, { status: 'queued', error: msg, attempts, next_poll_at: new Date(Date.now() + 15000 * attempts) });
  }
  console.warn(`[clip ${clip.id}] ${clip.provider} error (attempt ${attempts}): ${msg}`);
}

async function submit(clip) {
  const s = await getSettings();
  if (clip.provider === 'mock') {
    await setClip(clip.id, { status: 'ingesting' });
    return ingest(clip, null);
  }
  const p = PROVIDERS[clip.provider];
  if (!p) return fail({ ...clip, attempts: MAX_ATTEMPTS }, new Error(`Unknown provider ${clip.provider}`));
  try {
    const jobId = await p.submit(clip.input, s);
    await setClip(clip.id, { status: 'processing', provider_job_id: jobId, error: null, next_poll_at: new Date(Date.now() + 10000) });
  } catch (e) {
    await fail(clip, e);
  }
}

async function poll(clip) {
  const s = await getSettings();
  const p = PROVIDERS[clip.provider];
  try {
    const r = await p.poll(clip.provider_job_id, s);
    if (r.state === 'done') {
      await setClip(clip.id, { status: 'ingesting', remote_url: r.url });
      return ingest(clip, r.url);
    }
    if (r.state === 'failed') return setClip(clip.id, { status: 'failed', error: String(r.error).slice(0, 1000) });
    await setClip(clip.id, { next_poll_at: new Date(Date.now() + 10000) });
  } catch (e) {
    // transient poll errors: just try again later
    console.warn(`[clip ${clip.id}] poll error: ${e.message}`);
    await setClip(clip.id, { next_poll_at: new Date(Date.now() + 20000) });
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// Download (or synthesize), normalize, thumbnail and store a clip.
export async function ingest(clip, url, localFile = null) {
  ingesting++;
  const dir = await fsp.mkdtemp(path.join(WORK_DIR, 'clip-'));
  try {
    const raw = path.join(dir, 'raw.mp4');
    const norm = path.join(dir, 'norm.mp4');
    const thumb = path.join(dir, 'thumb.jpg');
    if (localFile) await fsp.copyFile(localFile, raw);
    else if (url) await download(url, raw);
    else {
      const seconds = clip.kind === 'aroll' ? estimateSpeechSeconds(clip.input.text) : clip.input.duration || 6;
      const label = clip.kind === 'aroll' ? `A-ROLL · ${clip.input.look || 'candidate'}` : 'B-ROLL';
      const text = clip.kind === 'aroll' ? clip.input.text : clip.input.description || clip.input.prompt;
      await placeholderClip(raw, { kind: clip.kind, label, text, seconds: Math.round(seconds * 10) / 10, seed: parseInt(clip.id.slice(0, 6), 16) });
    }
    const info = await normalize(raw, norm, { keepAudio: clip.kind === 'aroll' || clip.provider === 'upload' });
    await thumbnail(norm, thumb, Math.min(1, info.duration / 2));
    const mediaId = await putFile(norm, 'video/mp4', clip.project_id);
    const thumbId = await putFile(thumb, 'image/jpeg', clip.project_id);
    await setClip(clip.id, { status: 'ready', media_id: mediaId, thumb_media_id: thumbId, duration: info.duration, error: null });
  } catch (e) {
    await fail(clip, e);
  } finally {
    ingesting--;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function tick() {
  // 1) submit queued clips
  const queued = (await q(`SELECT * FROM clips WHERE status='queued' AND next_poll_at <= now() ORDER BY created_at LIMIT 6`)).rows;
  for (const c of queued) {
    if (busy.has(c.id)) continue;
    if (c.provider === 'mock' && ingesting >= MAX_INGEST) continue;
    busy.add(c.id);
    submit(c).finally(() => busy.delete(c.id));
  }
  // 2) poll in-flight jobs
  const inflight = (await q(`SELECT * FROM clips WHERE status='processing' AND next_poll_at <= now() ORDER BY next_poll_at LIMIT 10`)).rows;
  for (const c of inflight) {
    if (busy.has(c.id) || ingesting >= MAX_INGEST) continue;
    busy.add(c.id);
    poll(c).finally(() => busy.delete(c.id));
  }
  // 3) one export at a time
  if (!busy.has('export')) {
    const ex = await one(`SELECT * FROM exports WHERE status='queued' ORDER BY created_at LIMIT 1`);
    if (ex) {
      busy.add('export');
      runExport(ex).catch((e) => console.error('export error', e)).finally(() => busy.delete('export'));
    }
  }
}

export function startWorker() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      console.error('worker tick failed', e.message);
    } finally {
      running = false;
    }
  }, 2500);
}
