import React, { useContext, useState } from 'react';
import { ProjectCtx } from '../pages/Project.jsx';
import { api, mediaUrl, fmtTime } from '../api.js';
import { buildTimeline } from '../../shared/timeline.js';

export default function ExportPanel() {
  const { id, project, doc, clips, act, busy } = useContext(ProjectCtx);
  const [height, setHeight] = useState(1080);
  const tl = buildTimeline(doc, clips);
  const notReadyA = tl.v1.filter((i) => !i.ready).length;
  const notReadyB = tl.v2.filter((i) => !i.ready).length;
  const running = project.exports.find((e) => e.status === 'queued' || e.status === 'running');
  const slug = (project.title || 'podium').replace(/[^\w]+/g, '-').slice(0, 60);
  return (
    <div className="insp">
      <h3>⇪ Export</h3>
      <p className="muted small">Renders the full timeline (cuts, dips, b-roll fades, fade from/to black and the color layer) to an MP4.</p>
      <label>Resolution
        <select value={height} onChange={(e) => setHeight(Number(e.target.value))}>
          <option value={1080}>1080p (1920×1080)</option>
          <option value={720}>720p (1280×720), faster</option>
        </select>
      </label>
      {notReadyA > 0 && <div className="error small">{notReadyA} on-camera clip(s) aren't ready yet.</div>}
      {notReadyB > 0 && <div className="muted small">{notReadyB} b-roll clip(s) aren't ready and will be left out.</div>}
      <button className="primary" disabled={!!busy || !!running || notReadyA > 0 || !tl.v1.length}
        onClick={() => act('export', () => api(`/projects/${id}/export`, { method: 'POST', body: { height } }))}>
        Render {fmtTime(tl.duration)} video
      </button>
      <h4>Renders</h4>
      {project.exports.length === 0 && <p className="muted small">None yet.</p>}
      {project.exports.map((e) => (
        <div key={e.id} className="exportrow">
          <div className="row between small">
            <span>{new Date(e.created_at).toLocaleString()} · {e.options?.height || 1080}p</span>
            <span className={`badge ${e.status === 'done' ? 'ready' : e.status}`}>{e.status}</span>
          </div>
          {(e.status === 'running' || e.status === 'queued') && <div className="bar"><i style={{ width: `${Math.round(e.progress * 100)}%` }} /></div>}
          {e.status === 'failed' && <div className="error small">{e.error}</div>}
          {e.status === 'done' && (
            <>
              <video src={mediaUrl(e.media_id)} controls preload="metadata" className="clipprev" />
              <a className="button" href={`${mediaUrl(e.media_id)}?download=${slug}.mp4`}>⬇ Download MP4</a>
            </>
          )}
        </div>
      ))}
      {running && <p className="muted small">Rendering runs on the server; you can keep editing. Small server plans render slowly (roughly real-time or slower).</p>}
    </div>
  );
}
