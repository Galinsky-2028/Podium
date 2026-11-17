// Media lives in Postgres (chunked bytea) so it survives restarts on hosts without a
// persistent disk; a local disk cache serves byte-range requests to the editor.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { q, one, pool } from './db.js';

const CHUNK = 4 * 1024 * 1024;
export const CACHE_DIR = process.env.MEDIA_CACHE_DIR || path.join(os.tmpdir(), 'podium-media');
export const WORK_DIR = path.join(os.tmpdir(), 'podium-work');
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

export async function putFile(filePath, mime, projectId = null) {
  const stat = await fsp.stat(filePath);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO media (project_id, mime, size) VALUES ($1,$2,$3) RETURNING id',
      [projectId, mime, stat.size],
    );
    const id = rows[0].id;
    const fh = await fsp.open(filePath, 'r');
    let idx = 0;
    try {
      const buf = Buffer.alloc(CHUNK);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, idx * CHUNK);
        if (!bytesRead) break;
        await client.query('INSERT INTO media_chunks (media_id, idx, data) VALUES ($1,$2,$3)', [
          id, idx, Buffer.from(buf.subarray(0, bytesRead)),
        ]);
        idx++;
        if (bytesRead < CHUNK) break;
      }
    } finally {
      await fh.close();
    }
    await client.query('UPDATE media SET chunks=$2 WHERE id=$1', [id, idx]);
    await client.query('COMMIT');
    await fsp.copyFile(filePath, path.join(CACHE_DIR, id)).catch(() => {});
    return id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const inflight = new Map();
// Ensure the media is on local disk; returns {path, mime, size}.
export async function localPath(id) {
  const m = await one('SELECT id, mime, size, chunks FROM media WHERE id=$1', [id]);
  if (!m) return null;
  const p = path.join(CACHE_DIR, id);
  try {
    const st = await fsp.stat(p);
    if (st.size === Number(m.size)) return { path: p, mime: m.mime, size: Number(m.size) };
  } catch {}
  if (!inflight.has(id)) {
    inflight.set(id, (async () => {
      const tmp = `${p}.part${Date.now()}`;
      const fh = await fsp.open(tmp, 'w');
      try {
        for (let i = 0; i < m.chunks; i++) {
          const r = await one('SELECT data FROM media_chunks WHERE media_id=$1 AND idx=$2', [id, i]);
          await fh.write(r.data);
        }
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, p);
    })().finally(() => inflight.delete(id)));
  }
  await inflight.get(id);
  return { path: p, mime: m.mime, size: Number(m.size) };
}

export async function deleteMedia(id) {
  if (!id) return;
  await q('DELETE FROM media WHERE id=$1', [id]);
  await fsp.rm(path.join(CACHE_DIR, id), { force: true });
}

export async function storageUsage() {
  const r = await one('SELECT COALESCE(SUM(size),0)::bigint AS bytes, COUNT(*)::int AS files FROM media');
  return { bytes: Number(r.bytes), files: r.files };
}

// Express handler with HTTP Range support (needed for <video> seeking).
export async function serveMedia(req, res) {
  const info = await localPath(req.params.id);
  if (!info) return res.status(404).end();
  const { size, mime } = info;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${req.query.download.replace(/[^\w.-]/g, '_')}"`);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
    if (start >= size || end >= size || start > end) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(info.path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', size);
    fs.createReadStream(info.path).pipe(res);
  }
}
