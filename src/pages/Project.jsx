import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, mediaUrl, fmtTime } from '../api.js';
import { Toast } from '../App.jsx';
import Editor from '../editor/Editor.jsx';
import { buildTimeline, estimateSpeechSeconds } from '../../shared/timeline.js';

export const ProjectCtx = React.createContext(null);

const PENDING = new Set(['queued', 'processing', 'ingesting']);

export function StatusBadge({ clip }) {
  if (!clip) return <span className="badge gray">no clip</span>;
  const label = { queued: 'queued', processing: 'generating', ingesting: 'processing', ready: 'ready', failed: 'failed' }[clip.status];
  return <span className={`badge ${clip.status}`} title={clip.error || ''}>{clip.provider === 'mock' && clip.status === 'ready' ? 'demo' : label}</span>;
}

export default function Project({ id, tab }) {
  const toast = useContext(Toast);
  const [project, setProject] = useState(null);
  const [doc, setDocState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [customLuts, setCustomLuts] = useState([]);
  const [busy, setBusy] = useState('');
  const version = useRef(0);
  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const docRef = useRef(null);

  const applyProject = useCallback((p, { force = false } = {}) => {
    setProject(p);
    if (force || (!dirty.current && p.version !== version.current)) {
      version.current = p.version;
      docRef.current = p.doc;
      setDocState(p.doc);
    }
  }, []);

  const reload = useCallback(async (opts) => {
    const p = await api(`/projects/${id}`);
    applyProject(p, opts);
    return p;
  }, [id, applyProject]);

  useEffect(() => {
    reload({ force: true }).catch((e) => toast(e.message, 'error'));
    api('/settings').then(setSettings).catch(() => {});
    api('/luts').then(setCustomLuts).catch(() => {});
  }, [id]);

  // poll while things are in flight
  const pending = useMemo(() => project && (
    Object.values(project.clips).some((c) => PENDING.has(c.status)) ||
    ['speech', 'shots'].includes(project.doc?.pipeline?.stage) ||
    project.exports.some((e) => e.status === 'queued' || e.status === 'running')
  ), [project]);
  useEffect(() => {
    const t = setInterval(() => reload().catch(() => {}), pending ? 3000 : 12000);
    return () => clearInterval(t);
  }, [pending, reload]);

  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    if (!dirty.current) return;
    const d = docRef.current;
    try {
      const r = await api(`/projects/${id}`, { method: 'PUT', body: { doc: d, version: version.current } });
      version.current = r.version;
      if (docRef.current === d) dirty.current = false;
      else saveTimer.current = setTimeout(save, 400);
    } catch (e) {
      dirty.current = false;
      if (e.status === 409 && e.body?.project) {
        applyProject(e.body.project, { force: true });
        toast('The project was updated by the pipeline; your last change was merged out. Please redo it.', 'error');
      } else toast(`Save failed: ${e.message}`, 'error');
    }
  }, [id, applyProject, toast]);

  const setDoc = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(docRef.current) : updater;
    docRef.current = next;
    dirty.current = true;
    setDocState(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 500);
  }, [save]);

  // run a server action after flushing local edits
  const act = useCallback(async (label, fn) => {
    setBusy(label);
    try {
      await save();
      const r = await fn();
      if (r && r.id && r.doc) applyProject(r, { force: true });
      else if (r && r.project) applyProject(r.project, { force: true });
      else await reload({ force: true });
      return r;
    } catch (e) {
      toast(e.message, 'error');
      await reload({ force: true }).catch(() => {});
    } finally {
      setBusy('');
    }
  }, [save, reload, applyProject, toast]);

  const updateShot = useCallback((shotId, patch) => {
    setDoc((d) => ({ ...d, shots: d.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)) }));
  }, [setDoc]);

  if (!project || !doc) return <div className="page muted">Loading…</div>;
  const clips = project.clips;
  const ctx = { id, project, doc, setDoc, updateShot, clips, reload, act, busy, settings, customLuts, setCustomLuts, toast, save };
  const shots = doc.shots || [];
  const ready = shots.filter((s) => s.enabled !== false && clips[s.clipId]?.status === 'ready').length;
  const inflight = shots.filter((s) => PENDING.has(clips[s.clipId]?.status)).length;
  const failed = shots.filter((s) => clips[s.clipId]?.status === 'failed').length;
  const stage = doc.pipeline?.stage;

  const steps = [
    { key: 'script', label: 'Brief & speech', done: !!doc.speech?.text, active: stage === 'speech' },
    { key: 'shots', label: `Shot list${shots.length ? ` (${shots.length})` : ''}`, done: shots.length > 0, active: stage === 'shots' },
    { key: 'edit', label: `Clips ${ready}/${shots.filter((s) => s.enabled !== false).length}`, done: shots.length > 0 && ready === shots.filter((s) => s.enabled !== false).length, active: inflight > 0 },
    { key: 'edit', label: 'Edit & export', done: project.exports.some((e) => e.status === 'done') },
  ];

  return (
    <ProjectCtx.Provider value={ctx}>
      <div className={`project ${tab === 'edit' ? 'full' : ''}`}>
        <div className="projbar">
          <input className="titleinput" value={project.title} onChange={(e) => setProject({ ...project, title: e.target.value })}
            onBlur={(e) => api(`/projects/${id}`, { method: 'PUT', body: { title: e.target.value } }).catch(() => {})} />
          <div className="steps">
            {steps.map((s, i) => (
              <a key={i} href={`#/p/${id}/${s.key}`} className={`step ${s.done ? 'done' : ''} ${s.active ? 'active' : ''} ${tab === s.key && i !== 2 ? 'cur' : ''}`}>
                <span className="num">{s.done ? '✓' : s.active ? <span className="spin" /> : i + 1}</span>{s.label}
              </a>
            ))}
          </div>
          <div className="row gap">
            {failed > 0 && <button onClick={() => act('gen', () => api(`/projects/${id}/generate`, { method: 'POST' }))}>↻ Retry {failed} failed</button>}
            <button className="primary" disabled={!!busy || ['speech', 'shots'].includes(stage)}
              title="Speech → shot list → generate every clip → auto-edit"
              onClick={() => {
                if (shots.length && !confirm('Re-run the whole pipeline? This rewrites the speech and replaces the shot list (old clips stay in each shot\'s history only if you keep the shots).')) return;
                act('run', () => api(`/projects/${id}/run`, { method: 'POST', body: {} }));
              }}>
              ▶ Run everything
            </button>
          </div>
        </div>
        {stage && stage !== 'idle' && stage !== 'done' && (
          <div className={`pipebanner ${stage === 'error' ? 'err' : ''}`}>
            {stage === 'error' ? `Pipeline stopped: ${doc.pipeline.error}` : (
              <><span className="spin" /> {doc.pipeline.message} {stage === 'clips' && `${ready} ready, ${inflight} in progress${failed ? `, ${failed} failed` : ''}. You can start editing now; clips drop in as they finish.`}</>
            )}
          </div>
        )}
        {tab === 'script' && <ScriptTab />}
        {tab === 'shots' && <ShotsTab />}
        {tab === 'edit' && <Editor />}
      </div>
    </ProjectCtx.Provider>
  );
}

function ScriptTab() {
  const { id, project, doc, setDoc, act, busy } = useContext(ProjectCtx);
  const [revision, setRevision] = useState('');
  const fileRef = useRef();
  const speech = doc.speech?.text || '';
  const words = speech.trim() ? speech.trim().split(/\s+/).length : 0;
  const set = (k) => (e) => setDoc((d) => ({ ...d, [k]: e.target.value }));
  return (
    <div className="page two">
      <section className="card">
        <h2>Your input</h2>
        <label>Brief<textarea rows={8} value={doc.brief || ''} onChange={set('brief')} placeholder="What should the speech say? Key points, the story, the ask…" /></label>
        <div className="row gap">
          <label>Length (min)<input type="number" step="0.5" min="0.5" max="15" value={doc.lengthMinutes || 2} onChange={(e) => setDoc((d) => ({ ...d, lengthMinutes: Number(e.target.value) }))} /></label>
          <label className="grow">Tone<input value={doc.tone || ''} onChange={set('tone')} placeholder="e.g. urgent but hopeful" /></label>
          <label className="grow">Audience<input value={doc.audience || ''} onChange={set('audience')} placeholder="e.g. small business owners" /></label>
        </div>
        <h3>Source files</h3>
        <ul className="files">
          {project.files.map((f) => (
            <li key={f.id}>
              📄 {f.name} <span className="muted small">{f.chars ? `${Math.round(f.chars / 1000)}k chars` : 'no text'}</span>
              <button className="link danger" onClick={() => act('file', () => api(`/projects/${id}/files/${f.id}`, { method: 'DELETE' }))}>remove</button>
            </li>
          ))}
        </ul>
        <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md,.html,.htm" onChange={() => {
          const fd = new FormData();
          for (const f of fileRef.current.files) fd.append('files', f);
          act('upload', () => api(`/projects/${id}/files`, { method: 'POST', form: fd })).then(() => (fileRef.current.value = ''));
        }} />
        <div className="row gap" style={{ marginTop: 16 }}>
          <button className="primary" disabled={!!busy} onClick={() => act('speech', () => api(`/projects/${id}/speech`, { method: 'POST', body: {} }))}>
            {busy === 'speech' ? <><span className="spin" /> Writing…</> : speech ? '✎ Write a new draft' : '✎ Write the speech'}
          </button>
        </div>
      </section>
      <section className="card">
        <div className="row between">
          <h2>Speech</h2>
          <span className="muted small">{words} words · ~{fmtTime(estimateSpeechSeconds(speech))}</span>
        </div>
        {doc.speech?.notes && <p className="muted small">{doc.speech.notes}</p>}
        <textarea className="speech" rows={20} value={speech} placeholder="Write the speech with the button on the left, or paste your own here."
          onChange={(e) => setDoc((d) => ({ ...d, speech: { ...(d.speech || {}), text: e.target.value } }))} />
        <div className="row gap">
          <input className="grow" value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Ask for changes: e.g. shorter opening, mention the $40B figure, end on volunteering" />
          <button disabled={!!busy || !revision.trim() || !speech} onClick={() => act('speech', () => api(`/projects/${id}/speech`, { method: 'POST', body: { revision } })).then(() => setRevision(''))}>Revise</button>
        </div>
        <div className="row gap" style={{ marginTop: 16 }}>
          <button className="primary" disabled={!!busy || !speech.trim()} onClick={() => {
            if ((doc.shots || []).length && !confirm('Replace the current shot list and generate new clips?')) return;
            act('shots', () => api(`/projects/${id}/shots`, { method: 'POST' })).then(() => (window.location.hash = `#/p/${id}/edit`));
          }}>
            {busy === 'shots' ? <><span className="spin" /> Planning shots…</> : '→ Build shot list & generate clips'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ShotsTab() {
  const { id, doc, clips, updateShot, act, busy, settings } = useContext(ProjectCtx);
  const shots = doc.shots || [];
  const aroll = shots.filter((s) => s.type === 'aroll');
  const tl = buildTimeline(doc, clips);
  const at = Object.fromEntries([...tl.v1, ...tl.v2].map((i) => [i.shotId, i]));
  const looks = settings?.heygen?.looks?.filter((l) => l.key) || [];
  if (!shots.length) return <div className="page muted">No shot list yet. Write the speech, then build the shot list on the <a href={`#/p/${id}/script`}>Brief & speech</a> tab.</div>;
  return (
    <div className="page">
      <div className="row between">
        <h2>Shot list</h2>
        <button disabled={!!busy} onClick={() => act('gen', () => api(`/projects/${id}/generate`, { method: 'POST' }))}>Generate missing / failed clips</button>
      </div>
      <p className="muted small">Edit text or prompts here, then use ↻ to regenerate a shot. Everything you change here flows into the editor timeline.</p>
      <table className="shots">
        <thead><tr><th>#</th><th>Time</th><th>Shot</th><th>Spoken text / video prompt</th><th>Clip</th><th /></tr></thead>
        <tbody>
          {aroll.map((a, i) => (
            <React.Fragment key={a.id}>
              <ShotRow n={i + 1} shot={a} item={at[a.id]} clip={clips[a.clipId]} looks={looks} updateShot={updateShot} id={id} act={act} />
              {shots.filter((b) => b.type === 'broll' && b.anchor === a.id).map((b) => (
                <ShotRow key={b.id} n="↳" shot={b} item={at[b.id]} clip={clips[b.clipId]} updateShot={updateShot} id={id} act={act} />
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShotRow({ n, shot, item, clip, looks, updateShot, id, act }) {
  const isA = shot.type === 'aroll';
  return (
    <tr className={`${isA ? 'arow' : 'brow'} ${shot.enabled === false ? 'disabled' : ''}`}>
      <td>{n}</td>
      <td className="small">{item ? `${fmtTime(item.start)}–${fmtTime(item.end)}` : '—'}</td>
      <td style={{ width: 210 }}>
        <div className="small"><b>{isA ? 'Candidate' : 'B-roll'}</b> {shot.description}</div>
        {isA && looks?.length > 0 && (
          <select value={shot.look} onChange={(e) => updateShot(shot.id, { look: e.target.value })}>
            {looks.map((l) => <option key={l.key} value={l.key}>{l.label || l.key}</option>)}
          </select>
        )}
      </td>
      <td>
        <textarea rows={isA ? 3 : 2} value={isA ? shot.text : shot.prompt}
          onChange={(e) => updateShot(shot.id, isA ? { text: e.target.value } : { prompt: e.target.value })} />
      </td>
      <td style={{ width: 140 }}>
        {clip?.thumb_media_id && <img className="mini" src={mediaUrl(clip.thumb_media_id)} alt="" />}
        <div><StatusBadge clip={clip} /></div>
        {clip?.status === 'failed' && <div className="error small">{clip.error}</div>}
      </td>
      <td>
        <button title="Regenerate with the current text/prompt" onClick={() => act('regen', () => api(`/projects/${id}/shots/${shot.id}/revise`, { method: 'POST', body: {} }))}>↻</button>
      </td>
    </tr>
  );
}
