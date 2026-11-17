import React, { useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Toast } from '../App.jsx';
import { LOOKS } from '../../shared/luts.js';

export default function Settings() {
  const toast = useContext(Toast);
  const [s, setS] = useState(null);
  const [avatars, setAvatars] = useState(null);
  const [voices, setVoices] = useState(null);
  const [luts, setLuts] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/settings').then(setS).catch((e) => toast(e.message, 'error'));
    api('/luts').then(setLuts).catch(() => {});
  }, []);
  if (!s) return <div className="page muted">Loading…</div>;

  const set = (path, v) => setS((cur) => {
    const next = structuredClone(cur);
    const keys = path.split('.');
    let o = next;
    for (const k of keys.slice(0, -1)) o = o[k] ||= {};
    o[keys[keys.length - 1]] = v;
    return next;
  });
  const looks = s.heygen.looks || [];
  const setLook = (i, patch) => set('heygen.looks', looks.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setSaving(true);
    try {
      const body = structuredClone(s);
      for (const k of ['anthropicKey', 'heygenKey', 'xaiKey']) delete body[`${k}Set`];
      setS(await api('/settings', { method: 'PUT', body }));
      toast('Settings saved');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const loadHeygen = async () => {
    try {
      await save();
      const [a, v] = await Promise.all([api('/heygen/avatars'), api('/heygen/voices')]);
      setAvatars([...a.avatars, ...a.talkingPhotos]);
      setVoices(v);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const keyField = (k, label, hint) => (
    <label>{label} {s[`${k}Set`] ? <span className="badge ready">set</span> : <span className="badge gray">not set: demo mode</span>}
      <input type="password" autoComplete="off" value={s[k]} placeholder={hint} onChange={(e) => set(k, e.target.value)} onFocus={(e) => s[k].includes('•') && set(k, '')} />
    </label>
  );

  return (
    <div className="page settings">
      <div className="row between"><h1>Settings</h1><button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>

      <section className="card">
        <h2>API keys</h2>
        <p className="muted small">Stored in the app database on your server. Anything without a key runs in demo mode with placeholder output so you can still try the whole flow.</p>
        {keyField('anthropicKey', 'Anthropic (Claude) API key: speechwriting, shot planning, revisions', 'sk-ant-…')}
        {keyField('heygenKey', 'HeyGen API key: your on-camera clips', 'HeyGen → Settings → API')}
        {keyField('xaiKey', 'xAI API key: Grok Imagine b-roll', 'xai-…')}
        <label>Claude model<input value={s.claudeModel} onChange={(e) => set('claudeModel', e.target.value)} /></label>
      </section>

      <section className="card">
        <h2>Candidate & voice</h2>
        <div className="row gap">
          <label className="grow">Candidate name<input value={s.candidateName} onChange={(e) => set('candidateName', e.target.value)} /></label>
          <label className="grow">Title / context<input value={s.candidateTitle} onChange={(e) => set('candidateTitle', e.target.value)} placeholder="e.g. candidate for President of the United States" /></label>
        </div>
        <label>How you talk (style guide for the speechwriter)<textarea rows={4} value={s.voiceNotes} onChange={(e) => set('voiceNotes', e.target.value)} /></label>
      </section>

      <section className="card">
        <div className="row between">
          <h2>HeyGen: you on camera</h2>
          <button onClick={loadHeygen} disabled={!s.heygenKeySet && !(s.heygenKey && !s.heygenKey.includes('•'))}>Load my avatars & voices</button>
        </div>
        <p className="muted small">Add one “look” per avatar/framing you've made in HeyGen (e.g. podium wide, desk close-up, outdoor). The director picks between them to vary shots like a multi-camera edit.</p>
        <label>Voice
          {voices ? (
            <select value={s.heygen.voiceId} onChange={(e) => set('heygen.voiceId', e.target.value)}>
              <option value="">Select…</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name} {v.language ? `(${v.language})` : ''}</option>)}
            </select>
          ) : <input value={s.heygen.voiceId} onChange={(e) => set('heygen.voiceId', e.target.value)} placeholder="voice_id (use your cloned voice)" />}
        </label>
        <table className="looks">
          <thead><tr><th>Key</th><th>Label</th><th>HeyGen avatar</th><th>Type</th><th>When to use</th><th /></tr></thead>
          <tbody>
            {looks.map((l, i) => (
              <tr key={i}>
                <td><input value={l.key} onChange={(e) => setLook(i, { key: e.target.value.replace(/\s+/g, '-').toLowerCase() })} placeholder="podium" /></td>
                <td><input value={l.label} onChange={(e) => setLook(i, { label: e.target.value })} placeholder="At the podium, medium shot" /></td>
                <td>
                  {avatars ? (
                    <select value={l.avatarId} onChange={(e) => {
                      const a = avatars.find((x) => x.id === e.target.value);
                      setLook(i, { avatarId: e.target.value, avatarType: a?.type || 'avatar' });
                    }}>
                      <option value="">Select…</option>
                      {avatars.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.type === 'talking_photo' ? 'photo' : 'avatar'})</option>)}
                    </select>
                  ) : <input value={l.avatarId} onChange={(e) => setLook(i, { avatarId: e.target.value })} placeholder="avatar_id" />}
                </td>
                <td>
                  <select value={l.avatarType || 'avatar'} onChange={(e) => setLook(i, { avatarType: e.target.value })}>
                    <option value="avatar">Avatar</option>
                    <option value="talking_photo">Photo avatar</option>
                  </select>
                </td>
                <td><input value={l.description || ''} onChange={(e) => setLook(i, { description: e.target.value })} placeholder="openings and big moments" /></td>
                <td><button className="link danger" onClick={() => set('heygen.looks', looks.filter((_, j) => j !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => set('heygen.looks', [...looks, { key: `look-${looks.length + 1}`, label: '', avatarId: '', avatarType: 'avatar', description: '' }])}>＋ Add look</button>
        <div className="row gap" style={{ marginTop: 12 }}>
          <label>Width<input type="number" value={s.heygen.width} onChange={(e) => set('heygen.width', Number(e.target.value))} /></label>
          <label>Height<input type="number" value={s.heygen.height} onChange={(e) => set('heygen.height', Number(e.target.value))} /></label>
          <label>Voice speed<input type="number" step="0.05" min="0.5" max="1.5" value={s.heygen.speed} onChange={(e) => set('heygen.speed', Number(e.target.value))} /></label>
        </div>
        <p className="muted small">1080p output needs a HeyGen plan that allows it; use 1280×720 otherwise (Podium upscales to 1080p).</p>
      </section>

      <section className="card">
        <h2>Grok Imagine: b-roll</h2>
        <div className="row gap">
          <label className="grow">Model<input value={s.grok.model} onChange={(e) => set('grok.model', e.target.value)} /></label>
          <label>Resolution<select value={s.grok.resolution} onChange={(e) => set('grok.resolution', e.target.value)}><option>720p</option><option>480p</option><option>1080p</option></select></label>
          <label>Aspect<select value={s.grok.aspectRatio} onChange={(e) => set('grok.aspectRatio', e.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
        </div>
        <label>Style added to every b-roll prompt<textarea rows={3} value={s.grok.styleSuffix} onChange={(e) => set('grok.styleSuffix', e.target.value)} /></label>
      </section>

      <section className="card">
        <h2>Defaults</h2>
        <div className="row gap">
          <label>Speech length (min)<input type="number" step="0.5" value={s.defaults.lengthMinutes} onChange={(e) => set('defaults.lengthMinutes', Number(e.target.value))} /></label>
          <label>B-roll share (%)<input type="number" min="0" max="80" value={s.defaults.brollShare} onChange={(e) => set('defaults.brollShare', Number(e.target.value))} /></label>
          <label>Fallback LUT<select value={s.defaults.look} onChange={(e) => set('defaults.look', e.target.value)}>{LOOKS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label className="inline"><input type="checkbox" checked={!!s.defaults.autoExport} onChange={(e) => set('defaults.autoExport', e.target.checked)} /> Auto-render the MP4 when “Run everything” finishes</label>
        </div>
      </section>

      <section className="card">
        <h2>Imported LUTs</h2>
        {luts.length === 0 ? <p className="muted small">None. Import .cube files from the Color panel in the editor.</p> : (
          <ul className="files">{luts.map((l) => (
            <li key={l.id}>{l.name} <span className="muted small">{l.size}³</span>
              <button className="link danger" onClick={async () => { await api(`/luts/${l.id}`, { method: 'DELETE' }); setLuts(await api('/luts')); }}>remove</button></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
