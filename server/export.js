// Final render. Renders one segment per A-roll item (with the b-roll that overlaps it,
// dips, global fades and the LUT), then concatenates. Rendering per segment keeps memory
// low enough for small instances, and every segment uses the same baked .cube grade the
// browser preview uses.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { q, one } from './db.js';
import { run, probe, OUT_W, OUT_H } from './ffmpeg.js';
import { localPath, putFile, WORK_DIR } from './storage.js';
import { buildTimeline } from '../shared/timeline.js';
import { bakeGrade, toCube } from '../shared/luts.js';
import { loadCustomLuts } from './luts-store.js';

const THREADS = process.env.FFMPEG_THREADS || '2';
const f3 = (n) => Math.max(0, n).toFixed(3);

export async function loadClipsMap(projectId) {
  const rows = (await q('SELECT id, status, duration, media_id, thumb_media_id, error, kind, provider, input, shot_id, created_at FROM clips WHERE project_id=$1', [projectId])).rows;
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

const setEx = (id, f) => {
  const k = Object.keys(f);
  return q(`UPDATE exports SET ${k.map((x, i) => `${x}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [id, ...k.map((x) => f[x])]);
};

export async function runExport(ex) {
  await setEx(ex.id, { status: 'running', progress: 0, error: null });
  const dir = await fsp.mkdtemp(path.join(WORK_DIR, 'export-'));
  try {
    const project = await one('SELECT * FROM projects WHERE id=$1', [ex.project_id]);
    if (!project) throw new Error('Project not found');
    const doc = project.doc;
    const clips = await loadClipsMap(project.id);
    const tl = buildTimeline(doc, clips);
    if (!tl.v1.length) throw new Error('Nothing to export: the timeline has no A-roll.');
    const missing = tl.v1.filter((i) => !i.ready);
    if (missing.length) throw new Error(`${missing.length} on-camera clip(s) are not ready yet.`);

    const cube = path.join(dir, 'grade.cube');
    const customLuts = await loadCustomLuts();
    await fsp.writeFile(cube, toCube(bakeGrade(doc.grade, customLuts)));

    const height = ex.options?.height === 720 ? 720 : 1080;
    const width = height === 720 ? 1280 : OUT_W;
    const files = {};
    const fileFor = async (clipId) => (files[clipId] ||= (await localPath(clips[clipId].media_id)).path);

    const segs = [];
    for (let i = 0; i < tl.v1.length; i++) {
      const it = tl.v1[i];
      const overlays = tl.v2.filter((b) => b.ready && b.start < it.end - 0.01 && b.end > it.start + 0.01);
      const inputs = ['-i', await fileFor(it.clipId)];
      const vf = [];
      let base = `[0:v]trim=start=${f3(it.in)}:duration=${f3(it.dur)},setpts=PTS-STARTPTS`;
      if (it.dipIn) base += `,fade=t=in:st=0:d=${f3(it.dipIn)}`;
      if (it.dipOut) base += `,fade=t=out:st=${f3(it.dur - it.dipOut)}:d=${f3(it.dipOut)}`;
      vf.push(`${base}[b0]`);
      let cur = 'b0';
      for (let j = 0; j < overlays.length; j++) {
        const b = overlays[j];
        inputs.push('-i', await fileFor(b.clipId));
        const ls = Math.max(0, b.start - it.start);
        const le = Math.min(it.dur, b.end - it.start);
        const srcStart = b.in + Math.max(0, it.start - b.start);
        let o = `[${j + 1}:v]trim=start=${f3(srcStart)}:duration=${f3(le - ls)},setpts=PTS-STARTPTS+${f3(ls)}/TB,format=yuva420p`;
        if (b.start >= it.start - 0.001 && b.fadeIn) o += `,fade=t=in:st=${f3(ls)}:d=${f3(b.fadeIn)}:alpha=1`;
        if (b.end <= it.end + 0.001 && b.fadeOut) o += `,fade=t=out:st=${f3(le - b.fadeOut)}:d=${f3(b.fadeOut)}:alpha=1`;
        vf.push(`${o}[o${j}]`);
        vf.push(`[${cur}][o${j}]overlay=eof_action=pass:enable='between(t,${f3(ls)},${f3(le)})'[b${j + 1}]`);
        cur = `b${j + 1}`;
      }
      let post = `[${cur}]`;
      const tail = [];
      if (i === 0 && tl.fadeFromBlack) tail.push(`fade=t=in:st=0:d=${f3(tl.fadeFromBlack)}`);
      if (i === tl.v1.length - 1 && tl.fadeToBlack) tail.push(`fade=t=out:st=${f3(it.dur - tl.fadeToBlack)}:d=${f3(tl.fadeToBlack)}`);
      tail.push(`lut3d=file='${cube}':interp=tetrahedral`);
      if (height !== OUT_H) tail.push(`scale=${width}:${height}`);
      tail.push('format=yuv420p');
      vf.push(`${post}${tail.join(',')}[vout]`);
      let af = `[0:a]atrim=start=${f3(it.in)}:duration=${f3(it.dur)},asetpts=PTS-STARTPTS`;
      if (i === 0 && tl.fadeFromBlack) af += `,afade=t=in:st=0:d=${f3(Math.min(0.3, tl.fadeFromBlack))}`;
      if (i === tl.v1.length - 1 && tl.fadeToBlack) af += `,afade=t=out:st=${f3(it.dur - tl.fadeToBlack)}:d=${f3(tl.fadeToBlack)}`;
      vf.push(`${af}[aout]`);
      const out = path.join(dir, `seg${String(i).padStart(4, '0')}.mkv`);
      await run('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error', ...inputs,
        '-filter_complex', vf.join(';'), '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30', '-threads', THREADS,
        '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', out,
      ]);
      segs.push(out);
      await setEx(ex.id, { progress: ((i + 1) / tl.v1.length) * 0.95 });
    }
    const list = path.join(dir, 'list.txt');
    await fsp.writeFile(list, segs.map((s) => `file '${s}'`).join('\n'));
    const final = path.join(dir, 'final.mp4');
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final]);
    const info = await probe(final);
    const mediaId = await putFile(final, 'video/mp4', project.id);
    // keep only the latest few exports per project to save storage
    const old = (await q(`SELECT id, media_id FROM exports WHERE project_id=$1 AND status='done' ORDER BY created_at DESC OFFSET 2`, [project.id])).rows;
    for (const o of old) {
      await q('DELETE FROM exports WHERE id=$1', [o.id]);
      if (o.media_id) await q('DELETE FROM media WHERE id=$1', [o.media_id]);
    }
    await setEx(ex.id, { status: 'done', progress: 1, media_id: mediaId, options: { ...(ex.options || {}), duration: info.duration } });
  } catch (e) {
    console.error('export failed', e);
    await setEx(ex.id, { status: 'failed', error: String(e.message).slice(0, 2000) });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
