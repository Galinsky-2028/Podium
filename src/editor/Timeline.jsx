import React, { useContext, useEffect, useRef, useState } from 'react';
import { ProjectCtx } from '../pages/Project.jsx';
import { mediaUrl, fmtTime } from '../api.js';
import { LOOKS } from '../../shared/luts.js';

const HEAD = 92; // px label column

export default function Timeline({ tl, time, onSeek, selected, onSelect }) {
  const { doc, clips, updateShot, setDoc, customLuts } = useContext(ProjectCtx);
  const wrapRef = useRef();
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(0); // 0 = fit
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const dur = Math.max(tl.duration, 1);
  const fitPps = Math.max(4, (width - HEAD - 24) / dur);
  const pps = zoom ? fitPps * Math.pow(1.6, zoom) : fitPps;
  const X = (t) => t * pps;
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 70) || 120;

  const toTime = (clientX) => {
    const r = wrapRef.current.querySelector('.tracks').getBoundingClientRect();
    return Math.max(0, Math.min(dur, (clientX - r.left) / pps));
  };

  // ---- dragging b-roll (move / resize) and the playhead ----
  useEffect(() => {
    if (!drag) return;
    const move = (e) => {
      const dt = (e.clientX - drag.x0) / pps;
      if (drag.kind === 'scrub') return onSeek(toTime(e.clientX));
      setDrag((d) => ({ ...d, dt }));
    };
    const up = () => {
      if (drag.kind === 'move' && Math.abs(drag.dt || 0) > 0.02) {
        const newStart = Math.max(0, Math.min(tl.duration - 0.5, drag.item.start + drag.dt));
        const anchor = tl.v1.find((i) => newStart >= i.start && newStart < i.end) || tl.v1[tl.v1.length - 1];
        updateShot(drag.item.shotId, { anchor: anchor.shotId, offset: +(newStart - anchor.start).toFixed(2) });
      }
      if (drag.kind === 'resize' && Math.abs(drag.dt || 0) > 0.02) {
        updateShot(drag.item.shotId, { duration: +Math.max(0.5, drag.item.dur + drag.dt).toFixed(2) });
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag, pps, tl]);

  const lookName = LOOKS.find((l) => l.id === doc.grade?.look)?.name || customLuts?.find((l) => l.id === doc.grade?.look)?.name || 'None';
  const shotsById = Object.fromEntries((doc.shots || []).map((s) => [s.id, s]));

  const clipBox = (it, track) => {
    const clip = clips[it.clipId];
    const shot = shotsById[it.shotId];
    let left = X(it.start), w = X(it.dur);
    if (drag && drag.item.id === it.id) {
      if (drag.kind === 'move') left = X(Math.max(0, it.start + (drag.dt || 0)));
      if (drag.kind === 'resize') w = X(Math.max(0.5, it.dur + (drag.dt || 0)));
    }
    const thumb = clip?.thumb_media_id && mediaUrl(clip.thumb_media_id);
    return (
      <div key={it.id}
        className={`clip ${track} ${selected === it.shotId ? 'sel' : ''} ${it.ready ? '' : 'pending'} ${clip?.status === 'failed' ? 'failed' : ''}`}
        style={{ left, width: Math.max(4, w) }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(it.shotId);
          if (track === 'v2') setDrag({ kind: e.target.classList.contains('rh') ? 'resize' : 'move', item: it, x0: e.clientX, dt: 0 });
        }}
        title={`${shot?.description || ''}\n${track === 'v1' ? shot?.text : shot?.prompt}`}
      >
        {thumb && <div className="thumbs" style={{ backgroundImage: `url(${thumb})` }} />}
        <div className="cliplabel">
          {clip?.status === 'failed' ? '⚠ ' : !it.ready ? <span className="spin sm" /> : null}
          {track === 'v1' ? shot?.text : shot?.description || shot?.prompt}
        </div>
        {track === 'v2' && it.fadeIn > 0 && <div className="fade in" style={{ width: X(it.fadeIn) }} />}
        {track === 'v2' && it.fadeOut > 0 && <div className="fade out" style={{ width: X(it.fadeOut) }} />}
        {track === 'v1' && it.dipIn > 0 && <div className="dip in" style={{ width: X(it.dipIn) }} />}
        {track === 'v1' && it.dipOut > 0 && <div className="dip out" style={{ width: X(it.dipOut) }} />}
        {track === 'v2' && <div className="rh" />}
      </div>
    );
  };

  const ticks = [];
  for (let t = 0; t <= dur; t += step) ticks.push(t);

  return (
    <div className="timeline" ref={wrapRef}>
      <div className="tl-tools">
        <span className="muted small">Timeline · {fmtTime(tl.duration)}</span>
        <span className="grow" />
        <label className="small inline">Fade in from black <input type="number" min="0" max="5" step="0.1" value={doc.settings?.fadeFromBlack ?? 0.5}
          onChange={(e) => setDoc((d) => ({ ...d, settings: { ...d.settings, fadeFromBlack: Number(e.target.value) } }))} />s</label>
        <label className="small inline">Fade out <input type="number" min="0" max="5" step="0.1" value={doc.settings?.fadeToBlack ?? 1}
          onChange={(e) => setDoc((d) => ({ ...d, settings: { ...d.settings, fadeToBlack: Number(e.target.value) } }))} />s</label>
        <button onClick={() => setZoom((z) => Math.max(0, z - 1))}>−</button>
        <button onClick={() => setZoom(0)}>Fit</button>
        <button onClick={() => setZoom((z) => Math.min(8, z + 1))}>＋</button>
      </div>
      <div className="tl-body">
        <div className="heads" style={{ width: HEAD }}>
          <div className="h ruler" />
          <div className="h lut">Color</div>
          <div className="h v2">V2 B-roll</div>
          <div className="h v1">V1 Candidate</div>
          <div className="h a1">A1 Voice</div>
        </div>
        <div className="tl-scroll">
          <div className="tracks" style={{ width: X(dur) + 40 }}>
            <div className="ruler" onPointerDown={(e) => { onSeek(toTime(e.clientX)); setDrag({ kind: 'scrub', x0: e.clientX, item: {} }); }}>
              {ticks.map((t) => <span key={t} className="tick" style={{ left: X(t) }}>{fmtTime(t).replace(/\.0$/, '')}</span>)}
            </div>
            <div className="track lut" onPointerDown={() => onSelect('grade')}>
              <div className={`adj ${selected === 'grade' ? 'sel' : ''}`} style={{ left: 0, width: X(tl.duration) }}>
                🎨 Adjustment layer · LUT: <b>{lookName}</b>{doc.grade?.intensity !== 100 ? ` ${doc.grade?.intensity}%` : ''}
              </div>
            </div>
            <div className="track v2" onPointerDown={(e) => onSeek(toTime(e.clientX))}>{tl.v2.map((it) => clipBox(it, 'v2'))}</div>
            <div className="track v1" onPointerDown={(e) => onSeek(toTime(e.clientX))}>
              {tl.v1.map((it) => clipBox(it, 'v1'))}
              {tl.v1.slice(1).map((it) => {
                const s = shotsById[it.shotId];
                return (
                  <button key={`tr-${it.id}`} className={`trans ${s?.transition === 'dip' ? 'dip' : ''}`} style={{ left: X(it.start) - 9 }}
                    title={`Transition: ${s?.transition === 'dip' ? 'dip to black' : 'cut'} (click to toggle)`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => updateShot(it.shotId, { transition: s?.transition === 'dip' ? 'cut' : 'dip' })}>
                    {s?.transition === 'dip' ? '◐' : '|'}
                  </button>
                );
              })}
            </div>
            <div className="track a1" onPointerDown={(e) => onSeek(toTime(e.clientX))}>
              {tl.v1.map((it) => (
                <div key={it.id} className={`aclip ${it.ready ? '' : 'pending'}`} style={{ left: X(it.start), width: Math.max(2, X(it.dur)) }} />
              ))}
            </div>
            <div className="playhead" style={{ left: X(time) }} onPointerDown={(e) => { e.stopPropagation(); setDrag({ kind: 'scrub', x0: e.clientX, item: {} }); }} />
          </div>
        </div>
      </div>
    </div>
  );
}
