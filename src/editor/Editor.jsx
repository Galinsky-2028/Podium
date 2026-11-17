import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ProjectCtx } from '../pages/Project.jsx';
import { Engine } from './engine.js';
import Timeline from './Timeline.jsx';
import Inspector from './Inspector.jsx';
import GradePanel from './GradePanel.jsx';
import ExportPanel from './ExportPanel.jsx';
import { buildTimeline } from '../../shared/timeline.js';
import { bakeGrade, LUT_SIZE } from '../../shared/luts.js';
import { api, fmtTime } from '../api.js';

export default function Editor() {
  const ctx = useContext(ProjectCtx);
  const { id, doc, clips, customLuts, act, busy } = ctx;
  const canvasRef = useRef();
  const engineRef = useRef();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState(null); // shot id | 'grade' | 'export'
  const [bypass, setBypass] = useState(false);
  const [glError, setGlError] = useState('');
  const [adding, setAdding] = useState(null);

  const tl = useMemo(() => buildTimeline(doc, clips), [doc, clips]);
  const lutMap = useMemo(() => Object.fromEntries((customLuts || []).map((l) => [l.id, { size: l.size, table: l.table }])), [customLuts]);
  const lut = useMemo(() => bakeGrade(doc.grade, lutMap, LUT_SIZE), [doc.grade, lutMap]);

  useEffect(() => {
    try {
      const e = new Engine(canvasRef.current, { onTime: setTime, onState: setPlaying });
      engineRef.current = e;
      return () => e.destroy();
    } catch (err) {
      setGlError(err.message);
    }
  }, []);
  // fit a 16:9 box inside the viewer
  const screenRef = useRef();
  const [box, setBox] = useState({ w: 640, h: 360 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const W = e.contentRect.width - 20, H = e.contentRect.height - 20;
      const w = Math.max(160, Math.min(W, (H * 16) / 9));
      setBox({ w, h: (w * 9) / 16 });
    });
    ro.observe(screenRef.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { engineRef.current?.setTimeline(tl, clips); }, [tl, clips]);
  useEffect(() => { engineRef.current?.setLut(lut, LUT_SIZE); }, [lut]);
  useEffect(() => { if (engineRef.current) { engineRef.current.lutOn = !bypass; engineRef.current.dirty = true; } }, [bypass]);

  const seek = useCallback((t) => engineRef.current?.seek(t), []);
  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const en = engineRef.current;
      if (!en) return;
      if (e.code === 'Space') { e.preventDefault(); en.toggle(); }
      if (e.code === 'ArrowLeft') en.seek(en.t - (e.shiftKey ? 5 : 1 / 30));
      if (e.code === 'ArrowRight') en.seek(en.t + (e.shiftKey ? 5 : 1 / 30));
      if (e.code === 'Home') en.seek(0);
      if (e.code === 'End') en.seek(tl.duration);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tl.duration]);

  const cur = engineRef.current?.status || {};
  const curItem = tl.v2.find((i) => time >= i.start && time < i.end) || tl.v1.find((i) => time >= i.start && time < i.end);
  const curClip = curItem && clips[curItem.clipId];
  const notReady = curItem && !curItem.ready;

  const selShot = doc.shots?.find((s) => s.id === selected);
  const anchorAt = tl.v1.find((i) => time >= i.start && time < i.end) || tl.v1[tl.v1.length - 1];

  return (
    <div className="editor">
      <div className="ed-top">
        <div className="viewer">
          <div className="screen" ref={screenRef}>
            <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} />
            {glError && <div className="overlay error">{glError}</div>}
            {!tl.v1.length && <div className="overlay">No shots yet. Build the shot list first.</div>}
            {notReady && (
              <div className="overlay soft">
                <span className="spin" /> {curItem.track === 'v2' ? 'B-roll' : 'On-camera clip'}{' '}
                {curClip ? (curClip.status === 'failed' ? `failed: ${curClip.error || ''}` : 'is generating…') : 'has no clip yet'}
              </div>
            )}
          </div>
          <div className="transport">
            <button onClick={() => seek(0)} title="Start (Home)">⏮</button>
            <button className="play" onClick={() => engineRef.current?.toggle()} title="Play/pause (Space)">{playing ? '❚❚' : '▶'}</button>
            <span className="tc">{fmtTime(time)} / {fmtTime(tl.duration)}</span>
            <span className="grow" />
            <button className={bypass ? 'on' : ''} onMouseDown={() => setBypass(true)} onMouseUp={() => setBypass(false)} onMouseLeave={() => setBypass(false)} title="Hold to compare without the LUT">◐ Before</button>
            <button onClick={() => setAdding({ anchor: anchorAt?.shotId, offset: anchorAt ? Math.max(0, time - anchorAt.start) : 0, description: '', duration: 4 })} disabled={!tl.v1.length}>＋ B-roll here</button>
            <button className={selected === 'grade' ? 'on' : ''} onClick={() => setSelected('grade')}>🎨 Color</button>
            <button className={`primary ${selected === 'export' ? 'on' : ''}`} onClick={() => setSelected('export')}>⇪ Export</button>
          </div>
        </div>
        <aside className="inspector">
          {selected === 'grade' ? <GradePanel /> : selected === 'export' ? <ExportPanel /> : selShot ? (
            <Inspector shot={selShot} tl={tl} onSeek={seek} onClose={() => setSelected(null)} onDeleted={() => setSelected(null)} />
          ) : (
            <div className="empty">
              <h3>Edit</h3>
              <p className="muted">Click any clip in the timeline to tweak it, trim it, change its fades, or tell the AI what's wrong and regenerate it.</p>
              <p className="muted">Click the <b>Color</b> layer to change the LUT. Drag b-roll clips to move them; drag their right edge to change length.</p>
              <p className="muted small">Keys: Space play/pause · ←/→ frame · Shift+←/→ 5s</p>
            </div>
          )}
        </aside>
      </div>
      <Timeline tl={tl} time={time} onSeek={seek} selected={selected} onSelect={setSelected} />
      {adding && (
        <div className="modal" onClick={() => setAdding(null)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h3>Add b-roll at {fmtTime(time)}</h3>
            <label>What should we see?<textarea autoFocus rows={3} value={adding.description} onChange={(e) => setAdding({ ...adding, description: e.target.value })} placeholder="e.g. A nurse finishing a night shift, walking to her car at dawn" /></label>
            <label>Seconds on screen<input type="number" min="1.5" max="15" step="0.5" value={adding.duration} onChange={(e) => setAdding({ ...adding, duration: Number(e.target.value) })} /></label>
            <div className="row gap">
              <button className="primary" disabled={!adding.description.trim() || !!busy} onClick={async () => {
                const r = await act('broll', () => api(`/projects/${id}/broll`, { method: 'POST', body: adding }));
                setAdding(null);
                if (r?.shotId) setSelected(r.shotId);
              }}>{busy === 'broll' ? 'Adding…' : 'Generate'}</button>
              <button onClick={() => setAdding(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
