// Timeline is *derived* from the shot list + generated clips + per-shot overrides.
// This is what makes the edit "fully automatic yet fully editable": every user edit
// (trim, fade, transition, b-roll position) is stored on the shot, so swapping a clip
// for a regenerated version or re-timing the speech re-flows everything automatically.

export const WORDS_PER_SEC = 2.5;
export const DEFAULT_BROLL_FADE = 0.5;
export const DEFAULT_DIP = 0.6;

export const estimateSpeechSeconds = (text = '') =>
  Math.max(1.5, text.trim().split(/\s+/).filter(Boolean).length / WORDS_PER_SEC + 0.4);

export function newId(prefix = 'id') {
  const r = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return `${prefix}_${r}`;
}

export function defaultShot(type, extra = {}) {
  return {
    id: newId(type === 'aroll' ? 'a' : 'b'),
    type, // 'aroll' (candidate on camera, HeyGen) | 'broll' (cutaway, Grok Imagine / upload)
    enabled: true,
    text: '', // aroll: words spoken
    look: '', // aroll: avatar look key
    description: '', // human-readable description of the shot
    prompt: '', // broll: generator prompt
    anchor: null, // broll: aroll shot id it plays over
    offset: 0, // broll: seconds into the anchor segment
    duration: 5, // broll: desired seconds on screen
    trimIn: 0,
    trimOut: 0,
    fadeIn: type === 'broll' ? DEFAULT_BROLL_FADE : 0,
    fadeOut: type === 'broll' ? DEFAULT_BROLL_FADE : 0,
    transition: 'cut', // aroll: how this shot starts: 'cut' | 'dip' (dip to black)
    transitionDur: DEFAULT_DIP,
    clipId: null,
    versions: [], // [{clipId, feedback, at}]
    ...extra,
  };
}

/**
 * @param doc project doc {shots, settings:{fadeFromBlack, fadeToBlack}}
 * @param clips map clipId -> {status, duration}
 */
export function buildTimeline(doc, clips = {}) {
  const shots = doc.shots || [];
  const aroll = shots.filter((s) => s.type === 'aroll' && s.enabled !== false);
  const v1 = [];
  let t = 0;
  for (const s of aroll) {
    const clip = s.clipId ? clips[s.clipId] : null;
    const ready = clip && clip.status === 'ready' && clip.duration;
    const srcDur = ready ? clip.duration : estimateSpeechSeconds(s.text);
    const inP = Math.max(0, Math.min(s.trimIn || 0, srcDur - 0.2));
    const outP = Math.max(inP + 0.2, srcDur - (s.trimOut || 0));
    const dur = outP - inP;
    const dip = s.transition === 'dip' && v1.length > 0 ? Math.min(s.transitionDur || DEFAULT_DIP, dur / 2) : 0;
    v1.push({
      id: s.id, shotId: s.id, track: 'v1', clipId: s.clipId, ready: !!ready, estimated: !ready,
      start: t, end: t + dur, dur, in: inP, out: outP,
      dipIn: dip, dipOut: 0,
    });
    t += dur;
  }
  // dipOut of previous = dipIn of next (split the dip half/half)
  for (let i = 1; i < v1.length; i++) {
    if (v1[i].dipIn) {
      const half = v1[i].dipIn / 2;
      v1[i].dipIn = half;
      v1[i - 1].dipOut = Math.min(half, v1[i - 1].dur / 2);
    }
  }
  const total = t;
  const byShot = Object.fromEntries(v1.map((it) => [it.shotId, it]));
  const v2 = [];
  for (const s of shots.filter((x) => x.type === 'broll' && x.enabled !== false)) {
    const anchor = byShot[s.anchor] || v1[0];
    if (!anchor) continue;
    const clip = s.clipId ? clips[s.clipId] : null;
    const ready = clip && clip.status === 'ready' && clip.duration;
    const srcDur = ready ? clip.duration : Math.max(1, s.duration || 5);
    const start = Math.min(anchor.start + Math.max(0, s.offset || 0), Math.max(anchor.start, total - 0.5));
    const inP = Math.max(0, Math.min(s.trimIn || 0, srcDur - 0.2));
    const avail = Math.max(0.2, srcDur - inP - (s.trimOut || 0));
    const want = s.duration ? Math.min(s.duration, avail) : avail;
    const dur = Math.max(0.2, Math.min(want, total - start));
    const fi = Math.min(s.fadeIn ?? DEFAULT_BROLL_FADE, dur / 2);
    const fo = Math.min(s.fadeOut ?? DEFAULT_BROLL_FADE, dur / 2);
    v2.push({
      id: s.id, shotId: s.id, track: 'v2', clipId: s.clipId, ready: !!ready, estimated: !ready,
      anchor: anchor.shotId, start, end: start + dur, dur, in: inP, out: inP + dur, fadeIn: fi, fadeOut: fo,
    });
  }
  v2.sort((a, b) => a.start - b.start);
  const st = doc.settings || {};
  return {
    v1, v2, duration: total,
    fadeFromBlack: Math.min(st.fadeFromBlack ?? 0.5, total / 4),
    fadeToBlack: Math.min(st.fadeToBlack ?? 1.0, total / 4),
  };
}

// Opacity helpers shared by preview and export.
export function v1Brightness(item, tl, t) {
  let a = 1;
  const local = t - item.start;
  if (item.dipIn && local < item.dipIn) a = Math.min(a, local / item.dipIn);
  if (item.dipOut && item.end - t < item.dipOut) a = Math.min(a, (item.end - t) / item.dipOut);
  return Math.max(0, Math.min(1, a));
}
export function v2Alpha(item, t) {
  const local = t - item.start;
  let a = 1;
  if (item.fadeIn && local < item.fadeIn) a = Math.min(a, local / item.fadeIn);
  if (item.fadeOut && item.end - t < item.fadeOut) a = Math.min(a, (item.end - t) / item.fadeOut);
  return Math.max(0, Math.min(1, a));
}
export function globalBrightness(tl, t) {
  let a = 1;
  if (tl.fadeFromBlack && t < tl.fadeFromBlack) a = Math.min(a, t / tl.fadeFromBlack);
  if (tl.fadeToBlack && tl.duration - t < tl.fadeToBlack) a = Math.min(a, (tl.duration - t) / tl.fadeToBlack);
  return Math.max(0, Math.min(1, a));
}
export function itemsAt(tl, t) {
  const v1 = tl.v1.find((i) => t >= i.start && t < i.end) || null;
  let v2 = null;
  for (const i of tl.v2) if (t >= i.start && t < i.end) v2 = i; // later one wins
  return { v1, v2 };
}
