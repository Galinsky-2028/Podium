import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, one, migrate } from './db.js';
import { getSettings, saveSettings, publicSettings } from './settings.js';
import { serveMedia, storageUsage, WORK_DIR } from './storage.js';
import { writeSpeech, planShots, reviseShot } from './llm.js';
import { createClip, ingest, startWorker } from './jobs.js';
import { loadClipsMap } from './export.js';
import { heygen } from './providers.js';
import { loadCustomLuts, addCustomLut, deleteCustomLut } from './luts-store.js';
import { defaultShot, estimateSpeechSeconds } from '../shared/timeline.js';
import { defaultGrade, LOOK_IDS } from '../shared/luts.js';
import { extractText } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ---------------- auth (single shared password) ----------------
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`podium:${PASSWORD}`).digest('hex');
const token = () => crypto.createHmac('sha256', SECRET).update('podium-session-v1').digest('hex');
const authed = (req) => !PASSWORD || req.cookies.podium === token();

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.post('/api/login', (req, res) => {
  const ok = PASSWORD && typeof req.body.password === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(PASSWORD).digest());
  if (!PASSWORD || ok) {
    res.cookie('podium', token(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 60 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('podium'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authed: authed(req), passwordRequired: !!PASSWORD }));
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Not signed in' })));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message || String(e) });
});
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

const upload = multer({ dest: path.join(WORK_DIR, 'uploads'), limits: { fileSize: 600 * 1024 * 1024 } });

// ---------------- project doc helpers ----------------
async function updateDoc(id, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT * FROM projects WHERE id=$1 FOR NO KEY UPDATE', [id]);
    if (!rows[0]) throw httpErr(404, 'Project not found');
    const doc = rows[0].doc;
    const result = await fn(doc, rows[0]);
    const title = doc.speech?.title && rows[0].title === 'Untitled speech' ? doc.speech.title : rows[0].title;
    await c.query('UPDATE projects SET doc=$2, title=$3, version=version+1, updated_at=now() WHERE id=$1', [id, doc, title]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function projectPayload(id) {
  const p = await one('SELECT * FROM projects WHERE id=$1', [id]);
  if (!p) throw httpErr(404, 'Project not found');
  const clips = await loadClipsMap(id);
  const files = (await q('SELECT id, name, mime, size, length(text) AS chars, created_at FROM source_files WHERE project_id=$1 ORDER BY created_at', [id])).rows;
  const exports = (await q('SELECT id, status, progress, options, media_id, error, created_at FROM exports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5', [id])).rows;
  return { ...p, clips, files, exports };
}

function setPipeline(doc, stage, message = '', error = null) {
  doc.pipeline = { stage, message, error, at: new Date().toISOString() };
}

async function queueShot(projectId, doc, shot, s, feedback = null) {
  const clip = await createClip(projectId, shot, s);
  shot.versions = [...(shot.versions || []), { clipId: clip.id, feedback, at: new Date().toISOString() }];
  shot.clipId = clip.id;
  return clip;
}

function shotsFromPlan(plan, brollMax) {
  const aroll = plan.segments.map((seg, i) =>
    defaultShot('aroll', { text: seg.text.trim(), look: seg.look, transition: i === 0 ? 'cut' : seg.transition || 'cut', description: seg.description }),
  );
  const broll = [];
  for (const b of plan.broll || []) {
    const a = aroll[b.segment];
    if (!a) continue;
    const est = estimateSpeechSeconds(a.text);
    const duration = Math.max(2, Math.min(brollMax, b.duration || 4, est - 0.5));
    const offset = Math.max(0, Math.min(b.offset || 0, est - duration - 0.3));
    broll.push(defaultShot('broll', { anchor: a.id, offset, duration, description: b.description, prompt: b.prompt }));
  }
  return [...aroll, ...broll];
}

// ---------------- routes: settings ----------------
app.get('/api/settings', wrap(async (req, res) => res.json(publicSettings(await getSettings()))));
app.put('/api/settings', wrap(async (req, res) => res.json(publicSettings(await saveSettings(req.body || {})))));
app.get('/api/heygen/avatars', wrap(async (req, res) => {
  const s = await getSettings();
  if (!s.heygenKey) throw httpErr(400, 'Add your HeyGen API key first');
  res.json(await heygen.listAvatars(s));
}));
app.get('/api/heygen/voices', wrap(async (req, res) => {
  const s = await getSettings();
  if (!s.heygenKey) throw httpErr(400, 'Add your HeyGen API key first');
  res.json(await heygen.listVoices(s));
}));
app.get('/api/status', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({
    claude: !!s.anthropicKey,
    heygen: heygen.configured(s),
    grok: !!s.xaiKey,
    storage: await storageUsage(),
    activeJobs: (await one(`SELECT COUNT(*)::int AS n FROM clips WHERE status IN ('queued','processing','ingesting')`)).n,
  });
}));

// ---------------- routes: LUTs ----------------
app.get('/api/luts', wrap(async (req, res) => {
  const l = await loadCustomLuts();
  res.json(Object.values(l).map((x) => ({ id: x.id, name: x.name, size: x.size, table: Array.from(x.table) })));
}));
app.post('/api/luts', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpErr(400, 'No file');
  try {
    const text = await fsp.readFile(req.file.path, 'utf8');
    res.json(await addCustomLut(req.file.originalname, text));
  } finally {
    fsp.rm(req.file.path, { force: true });
  }
}));
app.delete('/api/luts/:id', wrap(async (req, res) => { await deleteCustomLut(req.params.id); res.json({ ok: true }); }));

// ---------------- routes: projects ----------------
app.get('/api/projects', wrap(async (req, res) => {
  const rows = (await q(`
    SELECT p.id, p.title, p.updated_at, p.created_at, p.doc->'pipeline' AS pipeline,
      (SELECT COUNT(*)::int FROM clips c WHERE c.project_id=p.id AND c.status='ready') AS ready,
      (SELECT COUNT(*)::int FROM clips c WHERE c.project_id=p.id AND c.status IN ('queued','processing','ingesting')) AS pending,
      (SELECT media_id FROM exports e WHERE e.project_id=p.id AND e.status='done' ORDER BY created_at DESC LIMIT 1) AS last_export,
      (SELECT c.thumb_media_id FROM clips c WHERE c.project_id=p.id AND c.kind='aroll' AND c.status='ready' ORDER BY created_at LIMIT 1) AS thumb
    FROM projects p ORDER BY p.updated_at DESC`)).rows;
  res.json(rows);
}));

app.post('/api/projects', wrap(async (req, res) => {
  const s = await getSettings();
  const doc = {
    brief: req.body.brief || '',
    lengthMinutes: s.defaults.lengthMinutes || 2,
    tone: '', audience: '',
    speech: null, shots: [],
    grade: defaultGrade(s.defaults.look || 'presidential-warm'),
    settings: { fadeFromBlack: 0.5, fadeToBlack: 1.0 },
    pipeline: { stage: 'idle' },
  };
  const p = await one('INSERT INTO projects (title, doc) VALUES ($1,$2) RETURNING id', [req.body.title || 'Untitled speech', doc]);
  res.json(await projectPayload(p.id));
}));

app.get('/api/projects/:id', wrap(async (req, res) => res.json(await projectPayload(req.params.id))));

// Client saves the whole doc with optimistic concurrency.
app.put('/api/projects/:id', wrap(async (req, res) => {
  const { doc, version, title } = req.body;
  const r = await one(
    `UPDATE projects SET doc=COALESCE($2, doc), title=COALESCE($4, title), version=version+1, updated_at=now()
     WHERE id=$1 AND ($3::int IS NULL OR version=$3) RETURNING version`,
    [req.params.id, doc || null, Number.isInteger(version) ? version : null, title || null],
  );
  if (!r) {
    const cur = await projectPayload(req.params.id);
    return res.status(409).json({ error: 'Project changed elsewhere; reloaded.', project: cur });
  }
  res.json({ version: r.version });
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  await q('DELETE FROM media WHERE project_id=$1', [req.params.id]);
  await q('DELETE FROM projects WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/files', upload.array('files', 20), wrap(async (req, res) => {
  for (const f of req.files || []) {
    try {
      const text = await extractText(f.path, f.originalname, f.mimetype);
      await q('INSERT INTO source_files (project_id, name, mime, size, text) VALUES ($1,$2,$3,$4,$5)', [req.params.id, f.originalname, f.mimetype, f.size, text]);
    } finally {
      fsp.rm(f.path, { force: true });
    }
  }
  res.json(await projectPayload(req.params.id));
}));
app.delete('/api/projects/:id/files/:fid', wrap(async (req, res) => {
  await q('DELETE FROM source_files WHERE id=$1 AND project_id=$2', [req.params.fid, req.params.id]);
  res.json(await projectPayload(req.params.id));
}));

async function doSpeech(id, { revision } = {}) {
  const s = await getSettings();
  const p = await one('SELECT doc FROM projects WHERE id=$1', [id]);
  const files = (await q('SELECT name, text FROM source_files WHERE project_id=$1 ORDER BY created_at', [id])).rows;
  const d = p.doc;
  const out = await writeSpeech(s, {
    brief: d.brief, files, lengthMinutes: d.lengthMinutes, tone: d.tone, audience: d.audience,
    revision, previous: d.speech?.text,
  });
  await updateDoc(id, (doc) => {
    doc.speech = { title: out.title, text: out.speech.trim(), notes: out.notes, at: new Date().toISOString() };
  });
}

async function doShots(id) {
  const s = await getSettings();
  const p = await one('SELECT doc FROM projects WHERE id=$1', [id]);
  if (!p.doc.speech?.text) throw httpErr(400, 'Write or paste a speech first');
  const plan = await planShots(s, { speech: p.doc.speech.text, brief: p.doc.brief, brollShare: s.defaults.brollShare });
  await updateDoc(id, async (doc) => {
    doc.shots = shotsFromPlan(plan, 8);
    if (plan.grade?.look && LOOK_IDS.includes(plan.grade.look)) doc.grade = { ...defaultGrade(plan.grade.look), lookReason: plan.grade.reason };
    for (const shot of doc.shots) await queueShot(id, doc, shot, s);
  });
}

async function withStage(id, stage, message, fn) {
  await updateDoc(id, (doc) => setPipeline(doc, stage, message));
  try {
    await fn();
  } catch (e) {
    await updateDoc(id, (doc) => setPipeline(doc, 'error', message, e.message));
    throw e;
  }
}

app.post('/api/projects/:id/speech', wrap(async (req, res) => {
  await withStage(req.params.id, 'speech', 'Writing speech…', () => doSpeech(req.params.id, { revision: req.body?.revision }));
  await updateDoc(req.params.id, (doc) => setPipeline(doc, 'idle'));
  res.json(await projectPayload(req.params.id));
}));

app.post('/api/projects/:id/shots', wrap(async (req, res) => {
  await withStage(req.params.id, 'shots', 'Planning shots…', () => doShots(req.params.id));
  await updateDoc(req.params.id, (doc) => setPipeline(doc, 'clips', 'Generating clips…'));
  res.json(await projectPayload(req.params.id));
}));

// Full automatic run: speech -> shot list -> clips (worker) -> timeline is derived live.
app.post('/api/projects/:id/run', wrap(async (req, res) => {
  const id = req.params.id;
  const skipSpeech = !!req.body?.skipSpeech;
  res.json({ ok: true });
  (async () => {
    if (!skipSpeech) await withStage(id, 'speech', 'Writing speech…', () => doSpeech(id));
    await withStage(id, 'shots', 'Planning shots…', () => doShots(id));
    await updateDoc(id, (doc) => { setPipeline(doc, 'clips', 'Generating clips…'); doc.autoExportPending = true; });
  })().catch((e) => console.error('pipeline failed', e.message));
}));

// Queue clips for any shot without a usable clip.
app.post('/api/projects/:id/generate', wrap(async (req, res) => {
  const s = await getSettings();
  const clips = await loadClipsMap(req.params.id);
  let n = 0;
  await updateDoc(req.params.id, async (doc) => {
    for (const shot of doc.shots || []) {
      const c = shot.clipId && clips[shot.clipId];
      if (shot.enabled !== false && (!c || c.status === 'failed')) { await queueShot(req.params.id, doc, shot, s); n++; }
    }
    if (n) setPipeline(doc, 'clips', 'Generating clips…');
  });
  res.json({ queued: n, project: await projectPayload(req.params.id) });
}));

function narrationContext(doc, shot) {
  if (shot.type === 'aroll') return shot.text;
  return doc.shots.find((s) => s.id === shot.anchor)?.text || '';
}

app.post('/api/projects/:id/shots/:shotId/revise', wrap(async (req, res) => {
  const s = await getSettings();
  const feedback = String(req.body?.feedback || '').trim();
  const p = await one('SELECT doc FROM projects WHERE id=$1', [req.params.id]);
  const shot = p?.doc.shots.find((x) => x.id === req.params.shotId);
  if (!shot) throw httpErr(404, 'Shot not found');
  const rev = feedback ? await reviseShot(s, { shot, feedback, context: narrationContext(p.doc, shot) }) : null;
  let explanation = rev?.explanation || 'Regenerating with the same inputs.';
  await updateDoc(req.params.id, async (doc) => {
    const sh = doc.shots.find((x) => x.id === req.params.shotId);
    if (rev) {
      if (sh.type === 'broll') {
        sh.prompt = rev.prompt || sh.prompt;
        if (rev.duration > 0) sh.duration = Math.min(15, Math.max(2, rev.duration));
      } else {
        if (rev.text && rev.text.trim() !== sh.text.trim()) {
          sh.text = rev.text.trim();
          if (doc.speech) doc.speech.text = doc.shots.filter((x) => x.type === 'aroll').map((x) => x.text).join(' ');
        }
        const looks = (s.heygen.looks || []).map((l) => l.key);
        if (rev.look && looks.includes(rev.look)) sh.look = rev.look;
      }
      if (rev.description) sh.description = rev.description;
    }
    await queueShot(req.params.id, doc, sh, s, feedback || null);
  });
  res.json({ explanation, project: await projectPayload(req.params.id) });
}));

app.post('/api/projects/:id/shots/:shotId/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpErr(400, 'No file');
  let clip;
  await updateDoc(req.params.id, async (doc) => {
    const sh = doc.shots.find((x) => x.id === req.params.shotId);
    if (!sh) throw httpErr(404, 'Shot not found');
    clip = await one(
      `INSERT INTO clips (project_id, shot_id, kind, provider, input, status) VALUES ($1,$2,$3,'upload',$4,'ingesting') RETURNING *`,
      [req.params.id, sh.id, sh.type, { filename: req.file.originalname }],
    );
    sh.versions = [...(sh.versions || []), { clipId: clip.id, feedback: `Uploaded ${req.file.originalname}`, at: new Date().toISOString() }];
    sh.clipId = clip.id;
  });
  ingest(clip, null, req.file.path).finally(() => fsp.rm(req.file.path, { force: true }));
  res.json(await projectPayload(req.params.id));
}));

// Add a new b-roll cutaway (from the editor) and generate it.
app.post('/api/projects/:id/broll', wrap(async (req, res) => {
  const s = await getSettings();
  const { anchor, offset = 0, duration = 4, description = '' } = req.body || {};
  if (!description.trim()) throw httpErr(400, 'Describe the shot');
  let newShot;
  const p = await one('SELECT doc FROM projects WHERE id=$1', [req.params.id]);
  const a = p.doc.shots.find((x) => x.id === anchor);
  const rev = await reviseShot(s, {
    shot: { type: 'broll', prompt: description, description, duration },
    feedback: `Write a strong text-to-video prompt for: ${description}`,
    context: a?.text || '',
  });
  await updateDoc(req.params.id, async (doc) => {
    newShot = defaultShot('broll', { anchor, offset, duration, description: description.slice(0, 120), prompt: rev.prompt || description });
    doc.shots.push(newShot);
    await queueShot(req.params.id, doc, newShot, s, null);
  });
  res.json({ shotId: newShot.id, project: await projectPayload(req.params.id) });
}));

app.post('/api/projects/:id/export', wrap(async (req, res) => {
  const height = req.body?.height === 720 ? 720 : 1080;
  await one(`INSERT INTO exports (project_id, options) VALUES ($1,$2) RETURNING id`, [req.params.id, { height }]);
  res.json(await projectPayload(req.params.id));
}));

app.get('/api/media/:id', wrap(serveMedia));

// Auto-export once a full pipeline run has all clips ready (if enabled in Settings).
setInterval(async () => {
  try {
    const s = await getSettings();
    const rows = (await q(`SELECT id, doc FROM projects WHERE doc->>'autoExportPending'='true'`)).rows;
    for (const p of rows) {
      const pend = await one(`SELECT COUNT(*)::int AS n FROM clips WHERE project_id=$1 AND status IN ('queued','processing','ingesting')`, [p.id]);
      if (pend.n) continue;
      await updateDoc(p.id, (doc) => { delete doc.autoExportPending; setPipeline(doc, 'done', 'All clips generated'); });
      if (s.defaults.autoExport) await q(`INSERT INTO exports (project_id, options) VALUES ($1,$2)`, [p.id, { height: 1080 }]);
    }
  } catch (e) {
    console.error('auto-export check failed', e.message);
  }
}, 8000);

// ---------------- static client ----------------
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = Number(process.env.PORT || 3000);
await migrate();
startWorker();
app.listen(PORT, () => console.log(`Podium listening on :${PORT}${PASSWORD ? '' : ' (no APP_PASSWORD set: open access)'}`));
