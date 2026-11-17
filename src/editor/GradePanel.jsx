import React, { useContext, useMemo, useRef } from 'react';
import { ProjectCtx } from '../pages/Project.jsx';
import { LOOKS, KNOBS, defaultGrade, bakeGrade } from '../../shared/luts.js';
import { api } from '../api.js';

// Small swatch preview of a look applied to a fixed test strip (skin, sky, foliage, greys).
const SWATCH = [[0.85, 0.62, 0.5], [0.55, 0.7, 0.9], [0.35, 0.5, 0.25], [0.15, 0.15, 0.17], [0.5, 0.5, 0.5], [0.95, 0.93, 0.9]];
function swatch(table, size) {
  return SWATCH.map(([r, g, b]) => {
    const i = (Math.round(r * (size - 1)) + Math.round(g * (size - 1)) * size + Math.round(b * (size - 1)) * size * size) * 3;
    return `rgb(${table[i] * 255},${table[i + 1] * 255},${table[i + 2] * 255})`;
  });
}

export default function GradePanel() {
  const { doc, setDoc, customLuts, setCustomLuts, toast } = useContext(ProjectCtx);
  const fileRef = useRef();
  const g = { ...defaultGrade('none'), ...(doc.grade || {}) };
  const set = (patch) => setDoc((d) => ({ ...d, grade: { ...g, ...patch } }));
  const groups = useMemo(() => {
    const m = {};
    for (const l of LOOKS) (m[l.group] ||= []).push(l);
    return m;
  }, []);
  const lutMap = useMemo(() => Object.fromEntries((customLuts || []).map((l) => [l.id, { size: l.size, table: l.table }])), [customLuts]);
  const swatches = useMemo(() => {
    const out = {};
    for (const l of LOOKS) out[l.id] = swatch(bakeGrade({ look: l.id }, {}, 9), 9);
    for (const l of customLuts || []) out[l.id] = swatch(bakeGrade({ look: l.id }, lutMap, 9), 9);
    return out;
  }, [customLuts, lutMap]);
  const allLooks = [...LOOKS, ...(customLuts || []).map((l) => ({ id: l.id, name: l.name, group: 'Custom' }))];
  const idx = allLooks.findIndex((l) => l.id === g.look);

  return (
    <div className="insp grade">
      <h3>🎨 Color (adjustment layer)</h3>
      {doc.grade?.lookReason && <p className="muted small">Auto-picked: {doc.grade.lookReason}</p>}
      <label>Look (LUT)
        <div className="row gap">
          <button onClick={() => set({ look: allLooks[(idx - 1 + allLooks.length) % allLooks.length].id })}>‹</button>
          <select className="grow" value={g.look} onChange={(e) => set({ look: e.target.value })}>
            {Object.entries(groups).map(([grp, ls]) => (
              <optgroup key={grp} label={grp}>{ls.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>
            ))}
            {customLuts?.length > 0 && (
              <optgroup label="Custom (.cube)">{customLuts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>
            )}
          </select>
          <button onClick={() => set({ look: allLooks[(idx + 1) % allLooks.length].id })}>›</button>
        </div>
      </label>
      <div className="lookgrid">
        {allLooks.map((l) => (
          <button key={l.id} className={`look ${l.id === g.look ? 'cur' : ''}`} onClick={() => set({ look: l.id })} title={l.name}>
            <span className="sw">{(swatches[l.id] || []).map((c, i) => <i key={i} style={{ background: c }} />)}</span>
            <span className="small ellip">{l.name}</span>
          </button>
        ))}
      </div>
      {KNOBS.map((k) => (
        <label key={k.key} className="knob">
          <span className="row between"><span>{k.label}</span><span className="muted">{g[k.key]}{k.unit || ''}</span></span>
          <input type="range" min={k.min} max={k.max} step={k.step} value={g[k.key]} onChange={(e) => set({ [k.key]: Number(e.target.value) })}
            onDoubleClick={() => set({ [k.key]: k.def })} />
        </label>
      ))}
      <div className="row gap">
        <button onClick={() => set(Object.fromEntries(KNOBS.map((k) => [k.key, k.def])))}>Reset knobs</button>
        <button onClick={() => fileRef.current.click()}>⇪ Import .cube LUT</button>
        <input ref={fileRef} type="file" accept=".cube" hidden onChange={async () => {
          const f = fileRef.current.files[0];
          if (!f) return;
          const fd = new FormData();
          fd.append('file', f);
          try {
            const r = await api('/luts', { method: 'POST', form: fd });
            const all = await api('/luts');
            setCustomLuts(all);
            set({ look: r.id });
            toast(`Imported ${r.name}`);
          } catch (e) {
            toast(e.message, 'error');
          }
          fileRef.current.value = '';
        }} />
      </div>
      <p className="muted small">Double-click a slider to reset it. Hold “◐ Before” under the viewer to compare. You can import the .cube files from Premiere's Lumetri LUT folder.</p>
    </div>
  );
}
