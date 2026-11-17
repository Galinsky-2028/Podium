import React, { useContext, useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../api.js';
import { Toast } from '../App.jsx';

export default function Projects() {
  const toast = useContext(Toast);
  const [list, setList] = useState(null);
  const [status, setStatus] = useState(null);
  const [creating, setCreating] = useState(false);
  const [brief, setBrief] = useState('');
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(2);
  const [busy, setBusy] = useState(false);
  const files = useRef();

  const load = () => {
    api('/projects').then(setList).catch((e) => toast(e.message, 'error'));
    api('/status').then(setStatus).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  async function create(run) {
    setBusy(true);
    try {
      const p = await api('/projects', { method: 'POST', body: { title: title || 'Untitled speech', brief } });
      const doc = { ...p.doc, lengthMinutes: Number(minutes) || 2 };
      await api(`/projects/${p.id}`, { method: 'PUT', body: { doc } });
      if (files.current?.files?.length) {
        const fd = new FormData();
        for (const f of files.current.files) fd.append('files', f);
        await api(`/projects/${p.id}/files`, { method: 'POST', form: fd });
      }
      if (run) await api(`/projects/${p.id}/run`, { method: 'POST', body: {} });
      window.location.hash = `#/p/${p.id}/${run ? 'edit' : 'script'}`;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      {status && (!status.claude || !status.heygen || !status.grok) && (
        <div className="banner">
          <b>Demo mode for:</b>{' '}
          {[!status.claude && 'speechwriting (Claude)', !status.heygen && 'on-camera clips (HeyGen)', !status.grok && 'b-roll (Grok Imagine)']
            .filter(Boolean)
            .join(', ')}
          . Placeholder clips are generated until you add keys in <a href="#/settings">Settings</a>.
        </div>
      )}
      <div className="row between">
        <h1>Videos</h1>
        <button className="primary" onClick={() => setCreating((c) => !c)}>＋ New speech video</button>
      </div>

      {creating && (
        <div className="card newproj">
          <label>Working title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Algorithmic Accountability Act announcement" /></label>
          <label>
            What should this speech say?
            <textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder="Your input: the message, key points, the story you want to tell, who it's for, what you want viewers to do…" />
          </label>
          <div className="row gap">
            <label className="grow">Source files (bill text, policy memo, notes: PDF, DOCX, TXT)<input ref={files} type="file" multiple accept=".pdf,.docx,.txt,.md,.html,.htm" /></label>
            <label style={{ width: 140 }}>Length (min)<input type="number" min="0.5" max="15" step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
          </div>
          <div className="row gap">
            <button className="primary" disabled={busy || !brief.trim()} onClick={() => create(true)}>
              {busy ? 'Starting…' : '▶ Make the whole video automatically'}
            </button>
            <button disabled={busy} onClick={() => create(false)}>Create and go step by step</button>
          </div>
        </div>
      )}

      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? (
        <p className="muted">No videos yet. Start one above.</p>
      ) : (
        <div className="grid">
          {list.map((p) => (
            <a key={p.id} className="pcard" href={`#/p/${p.id}/edit`}>
              <div className="thumb">{p.thumb ? <img src={mediaUrl(p.thumb)} alt="" /> : <span>🎙</span>}</div>
              <div className="pbody">
                <b>{p.title}</b>
                <div className="muted small">
                  {p.pending ? `Generating ${p.pending} clip(s)… ` : ''}
                  {p.ready} clips ready · {new Date(p.updated_at).toLocaleString()}
                </div>
                {p.pipeline?.stage === 'error' && <div className="error small">{p.pipeline.error}</div>}
                {p.last_export && <div className="small ok">✓ Exported</div>}
              </div>
            </a>
          ))}
        </div>
      )}
      {status && <p className="muted small">Storage used: {(status.storage.bytes / 1e6).toFixed(0)} MB in {status.storage.files} files</p>}
    </div>
  );
}
