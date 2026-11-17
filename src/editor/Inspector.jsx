import React, { useContext, useRef, useState } from 'react';
import { ProjectCtx, StatusBadge } from '../pages/Project.jsx';
import { api, mediaUrl, fmtTime } from '../api.js';

function Num({ label, value, onChange, step = 0.1, min = 0, max = 60, suffix = 's' }) {
  return (
    <label className="num">
      <span>{label}</span>
      <input type="number" step={step} min={min} max={max} value={Number.isFinite(value) ? +(+value).toFixed(2) : 0}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
      <span className="muted">{suffix}</span>
    </label>
  );
}

export default function Inspector({ shot, tl, onSeek, onClose, onDeleted }) {
  const { id, clips, updateShot, setDoc, act, busy, settings, toast } = useContext(ProjectCtx);
  const [feedback, setFeedback] = useState('');
  const [explain, setExplain] = useState('');
  const fileRef = useRef();
  const isA = shot.type === 'aroll';
  const clip = clips[shot.clipId];
  const item = [...tl.v1, ...tl.v2].find((i) => i.shotId === shot.id);
  const looks = settings?.heygen?.looks?.filter((l) => l.key) || [];
  const up = (patch) => updateShot(shot.id, patch);
  const inflight = clip && ['queued', 'processing', 'ingesting'].includes(clip.status);

  const revise = async (fb) => {
    const r = await act('revise', () => api(`/projects/${id}/shots/${shot.id}/revise`, { method: 'POST', body: { feedback: fb } }));
    if (r?.explanation) { setExplain(r.explanation); toast(r.explanation); }
    setFeedback('');
  };

  return (
    <div className="insp">
      <div className="row between">
        <h3>{isA ? '🎙 Candidate on camera' : '🎞 B-roll cutaway'}</h3>
        <button className="link" onClick={onClose}>✕</button>
      </div>
      <div className="row gap small">
        <StatusBadge clip={clip} />
        {item && <a className="link" onClick={() => onSeek(item.start + 0.01)}>{fmtTime(item.start)} – {fmtTime(item.end)}</a>}
        {clip?.provider && <span className="muted">via {clip.provider === 'mock' ? 'demo placeholder' : clip.provider}</span>}
      </div>
      {clip?.status === 'failed' && <div className="error small">{clip.error}</div>}
      {clip?.status === 'ready' && clip.media_id && (
        <video className="clipprev" src={mediaUrl(clip.media_id)} poster={mediaUrl(clip.thumb_media_id)} controls preload="none" muted={!isA} />
      )}

      <div className="fixbox">
        <label>
          <b>Don't like it?</b> Say what's wrong, what to change, or what to show instead:
          <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)}
            placeholder={isA ? 'e.g. use the close-up framing here; say "forty billion" instead of "40B"' : 'e.g. too generic, show a small-town hardware store owner unlocking the door at dawn'} />
        </label>
        <div className="row gap">
          <button className="primary" disabled={!!busy || !feedback.trim()} onClick={() => revise(feedback)}>
            {busy === 'revise' ? <><span className="spin" /> Rewriting…</> : '✦ Fix & regenerate'}
          </button>
          <button disabled={!!busy} onClick={() => revise('')} title="Regenerate with the current settings">↻ Regenerate</button>
          <button disabled={!!busy} onClick={() => fileRef.current.click()} title="Use your own footage for this shot">⇪ Upload</button>
          <input ref={fileRef} type="file" accept="video/*" hidden onChange={() => {
            const f = fileRef.current.files[0];
            if (!f) return;
            const fd = new FormData();
            fd.append('file', f);
            act('upload', () => api(`/projects/${id}/shots/${shot.id}/upload`, { method: 'POST', form: fd })).then(() => (fileRef.current.value = ''));
          }} />
        </div>
        {inflight && <p className="muted small"><span className="spin sm" /> New version is generating; it will replace this one in the timeline when ready.</p>}
        {explain && <p className="muted small">✦ {explain}</p>}
      </div>

      {isA ? (
        <>
          <label>Spoken text<textarea rows={4} value={shot.text} onChange={(e) => up({ text: e.target.value })} /></label>
          <p className="muted small">Text edits apply when you ↻ Regenerate this shot.</p>
          {looks.length > 0 && (
            <label>Look / framing
              <select value={shot.look} onChange={(e) => up({ look: e.target.value })}>
                {looks.map((l) => <option key={l.key} value={l.key}>{l.label || l.key}</option>)}
              </select>
            </label>
          )}
          <div className="grid2">
            <label>Transition in
              <select value={shot.transition || 'cut'} onChange={(e) => up({ transition: e.target.value })}>
                <option value="cut">Cut</option>
                <option value="dip">Dip to black</option>
              </select>
            </label>
            {shot.transition === 'dip' && <Num label="Dip length" value={shot.transitionDur ?? 0.6} onChange={(v) => up({ transitionDur: v })} max={3} />}
            <Num label="Trim start" value={shot.trimIn || 0} onChange={(v) => up({ trimIn: v })} />
            <Num label="Trim end" value={shot.trimOut || 0} onChange={(v) => up({ trimOut: v })} />
          </div>
        </>
      ) : (
        <>
          <label>Description<input value={shot.description || ''} onChange={(e) => up({ description: e.target.value })} /></label>
          <label>Video prompt<textarea rows={4} value={shot.prompt} onChange={(e) => up({ prompt: e.target.value })} /></label>
          <div className="grid2">
            <Num label="On screen" value={shot.duration || 4} onChange={(v) => up({ duration: Math.max(0.5, v) })} max={15} />
            <Num label="Start offset" value={shot.offset || 0} onChange={(v) => up({ offset: v })} max={600} />
            <Num label="Fade in" value={shot.fadeIn ?? 0.5} onChange={(v) => up({ fadeIn: v })} max={3} />
            <Num label="Fade out" value={shot.fadeOut ?? 0.5} onChange={(v) => up({ fadeOut: v })} max={3} />
            <Num label="Trim start" value={shot.trimIn || 0} onChange={(v) => up({ trimIn: v })} />
          </div>
          <p className="muted small">Fade 0 = hard cut. The candidate's voice keeps playing under b-roll.</p>
        </>
      )}

      <div className="row gap">
        <label className="inline small"><input type="checkbox" checked={shot.enabled !== false} onChange={(e) => up({ enabled: e.target.checked })} /> Include in video</label>
        {!isA && (
          <button className="link danger" onClick={() => {
            if (!confirm('Delete this b-roll shot?')) return;
            setDoc((d) => ({ ...d, shots: d.shots.filter((s) => s.id !== shot.id) }));
            onDeleted();
          }}>Delete b-roll</button>
        )}
      </div>

      {(shot.versions || []).length > 1 && (
        <>
          <h4>Versions</h4>
          <div className="versions">
            {[...shot.versions].reverse().map((v, i) => {
              const c = clips[v.clipId];
              return (
                <button key={v.clipId} className={`ver ${v.clipId === shot.clipId ? 'cur' : ''}`} onClick={() => up({ clipId: v.clipId })} title={v.feedback || 'original'}>
                  {c?.thumb_media_id ? <img src={mediaUrl(c.thumb_media_id)} alt="" /> : <div className="ph" />}
                  <span className="small">v{shot.versions.length - i} <StatusBadge clip={c} /></span>
                  {v.feedback && <span className="small muted ellip">“{v.feedback}”</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
