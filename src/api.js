export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (res.status === 401 && path !== '/login') {
    window.dispatchEvent(new Event('podium:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, json?.error || `HTTP ${res.status}`, json);
  return json;
}

export const mediaUrl = (id) => (id ? `/api/media/${id}` : null);

export function fmtTime(t) {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function useHashRoute(React) {
  const [hash, setHash] = React.useState(window.location.hash || '#/');
  React.useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '').split('/').filter(Boolean);
}
