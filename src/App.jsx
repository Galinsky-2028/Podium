import React, { useEffect, useState, useCallback } from 'react';
import { api, useHashRoute } from './api.js';
import Projects from './pages/Projects.jsx';
import Project from './pages/Project.jsx';
import Settings from './pages/Settings.jsx';

export const Toast = React.createContext(() => {});

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/login', { method: 'POST', body: { password: pw } });
            onDone();
          } catch (e2) {
            setErr(e2.message);
          }
        }}
      >
        <div className="brand big"><span className="logo" /> Podium</div>
        <p className="muted">Campaign speech video studio</p>
        <input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="error">{err}</div>}
        <button className="primary">Sign in</button>
      </form>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [toasts, setToasts] = useState([]);
  const route = useHashRoute(React);
  const refreshMe = useCallback(() => api('/me').then(setMe).catch(() => setMe({ authed: false, passwordRequired: true })), []);
  useEffect(() => {
    refreshMe();
    const out = () => setMe((m) => ({ ...(m || {}), authed: false }));
    window.addEventListener('podium:logout', out);
    return () => window.removeEventListener('podium:logout', out);
  }, [refreshMe]);
  const toast = useCallback((msg, kind = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  if (!me) return <div className="center muted">Loading…</div>;
  if (!me.authed) return <Login onDone={refreshMe} />;

  let page;
  if (route[0] === 'p' && route[1]) page = <Project key={route[1]} id={route[1]} tab={route[2] || 'edit'} />;
  else if (route[0] === 'settings') page = <Settings />;
  else page = <Projects />;

  return (
    <Toast.Provider value={toast}>
      <div className="app">
        <header className="topbar">
          <a href="#/" className="brand"><span className="logo" /> Podium</a>
          <nav>
            <a href="#/" className={!route[0] ? 'active' : ''}>Videos</a>
            <a href="#/settings" className={route[0] === 'settings' ? 'active' : ''}>Settings</a>
            {me.passwordRequired && (
              <button className="link" onClick={() => api('/logout', { method: 'POST' }).then(refreshMe)}>Sign out</button>
            )}
          </nav>
        </header>
        <main>{page}</main>
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
          ))}
        </div>
      </div>
    </Toast.Provider>
  );
}
