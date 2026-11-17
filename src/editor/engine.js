// Real-time preview: plays the derived timeline with <video> elements and composites
// V1 (candidate) + V2 (b-roll, with alpha fades) + dips/global fades + the 3D LUT in WebGL2.
import { itemsAt, v1Brightness, v2Alpha, globalBrightness } from '../../shared/timeline.js';

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.)/2., 1.-(p.y+1.)/2.); gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D A; uniform sampler2D B; uniform sampler3D L;
uniform float hasA, hasB, alphaB, brightA, brightAll, lutOn, lutSize;
void main(){
  vec3 c = vec3(0.07);
  if (hasA > .5) c = texture(A, uv).rgb * brightA; else c *= brightA;
  if (hasB > .5) c = mix(c, texture(B, uv).rgb, alphaB);
  c *= brightAll;
  if (lutOn > .5) {
    vec3 q = clamp(c,0.,1.) * ((lutSize-1.)/lutSize) + 0.5/lutSize;
    c = texture(L, q).rgb;
  }
  o = vec4(c, 1.);
}`;

export class Engine {
  constructor(canvas, { onTime, onState } = {}) {
    this.canvas = canvas;
    this.onTime = onTime || (() => {});
    this.onState = onState || (() => {});
    this.tl = { v1: [], v2: [], duration: 0 };
    this.clips = {};
    this.videos = new Map(); // mediaId -> video
    this.t = 0;
    this.playing = false;
    this.lutOn = true;
    this.volume = 1;
    this._initGL();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  _initGL() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is required for the preview');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex2 = (unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    };
    this.texA = tex2(0);
    this.texB = tex2(1);
    gl.activeTexture(gl.TEXTURE2);
    this.texL = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.texL);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.u = Object.fromEntries(
      ['A', 'B', 'L', 'hasA', 'hasB', 'alphaB', 'brightA', 'brightAll', 'lutOn', 'lutSize'].map((n) => [n, gl.getUniformLocation(prog, n)]),
    );
    gl.uniform1i(this.u.A, 0);
    gl.uniform1i(this.u.B, 1);
    gl.uniform1i(this.u.L, 2);
    this.lutSize = 0;
  }

  setLut(table, size) {
    const gl = this.gl;
    const data = new Uint8Array(table.length);
    for (let i = 0; i < table.length; i++) data[i] = Math.round(Math.max(0, Math.min(1, table[i])) * 255);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.texL);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    this.lutSize = size;
    this.dirty = true;
  }

  setTimeline(tl, clips) {
    this.tl = tl;
    this.clips = clips;
    if (this.t > tl.duration) this.t = tl.duration;
    this.dirty = true;
  }

  mediaFor(item) {
    if (!item || !item.ready) return null;
    const c = this.clips[item.clipId];
    return c && c.media_id;
  }

  video(mediaId) {
    let v = this.videos.get(mediaId);
    if (!v) {
      v = document.createElement('video');
      v.src = `/api/media/${mediaId}`;
      v.preload = 'auto';
      v.playsInline = true;
      v.muted = true;
      v.addEventListener('loadeddata', () => (this.dirty = true));
      v.addEventListener('seeked', () => (this.dirty = true));
      this.videos.set(mediaId, v);
      // keep a bounded pool
      if (this.videos.size > 14) {
        for (const [k, old] of this.videos) {
          if (k === mediaId || !old.paused) continue;
          old.removeAttribute('src');
          old.load();
          this.videos.delete(k);
          if (this.videos.size <= 10) break;
        }
      }
    }
    return v;
  }

  play() {
    if (this.t >= this.tl.duration - 0.05) this.t = 0;
    this.playing = true;
    this._wallStart = performance.now();
    this._tStart = this.t;
    this._activeA = null;
    this.onState(true);
  }
  pause() {
    this.playing = false;
    for (const v of this.videos.values()) if (!v.paused) v.pause();
    this.onState(false);
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    this.t = Math.max(0, Math.min(this.tl.duration || 0, t));
    this._wallStart = performance.now();
    this._tStart = this.t;
    this._activeA = null;
    this.dirty = true;
    this.onTime(this.t);
  }

  _sync(item, srcTime, { audio }) {
    const id = this.mediaFor(item);
    if (!id) return null;
    const v = this.video(id);
    v.muted = !audio;
    v.volume = audio ? this.volume : 0;
    if (this.playing) {
      if (Math.abs(v.currentTime - srcTime) > 0.3 && !v.seeking) v.currentTime = srcTime;
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - srcTime) > 0.04 && !v.seeking) v.currentTime = srcTime;
    }
    return v;
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    const tl = this.tl;
    if (this.playing) {
      // master clock: the active candidate clip (its audio) when available, else wall clock
      let t = this._tStart + (performance.now() - this._wallStart) / 1000;
      const a = this._activeA;
      if (a && a.v && !a.v.paused && !a.v.seeking && a.v.readyState >= 2) {
        const vt = a.item.start + (a.v.currentTime - a.item.in);
        if (vt >= a.item.start && vt < a.item.end + 0.1 && Math.abs(vt - t) < 0.5) {
          t = vt;
          this._tStart = t;
          this._wallStart = performance.now();
        }
      }
      if (t >= tl.duration) {
        t = tl.duration;
        this.t = t;
        this.pause();
      }
      this.t = t;
      this.onTime(t);
    } else if (!this.dirty) {
      // still re-render periodically while paused so freshly loaded frames appear
      if ((this._idle = (this._idle || 0) + 1) % 15) return;
    }
    this.dirty = false;
    const t = this.t;
    const { v1, v2 } = itemsAt(tl, Math.min(t, Math.max(0, tl.duration - 0.001)));
    const va = v1 ? this._sync(v1, v1.in + (t - v1.start), { audio: true }) : null;
    this._activeA = v1 ? { item: v1, v: va } : null;
    const vb = v2 ? this._sync(v2, v2.in + (t - v2.start), { audio: false }) : null;
    // pause anything else that's playing
    for (const v of this.videos.values()) if (v !== va && v !== vb && !v.paused) v.pause();
    // preload upcoming clips
    if (this.playing && v1) {
      const next = tl.v1[tl.v1.indexOf(v1) + 1];
      const nid = this.mediaFor(next);
      if (nid && next.start - t < 2) { const nv = this.video(nid); if (nv.paused && Math.abs(nv.currentTime - next.in) > 0.05) nv.currentTime = next.in; }
      for (const b of tl.v2) {
        const bid = this.mediaFor(b);
        if (bid && b.start > t && b.start - t < 2) { const bv = this.video(bid); if (bv.paused && Math.abs(bv.currentTime - b.in) > 0.05) bv.currentTime = b.in; }
      }
    }
    this._draw(v1, va, v2, vb, t);
    this.status = { v1, v2 };
  }

  _draw(v1, va, v2, vb, t) {
    const gl = this.gl;
    const c = this.canvas;
    const cw = Math.max(2, Math.round(c.clientWidth * devicePixelRatio));
    const ch = Math.max(2, Math.round(c.clientHeight * devicePixelRatio));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    gl.viewport(0, 0, c.width, c.height);
    const up = (unit, tex, v) => {
      if (!v || v.readyState < 2) return false;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
        return true;
      } catch {
        return false;
      }
    };
    const hasA = up(0, this.texA, va);
    const hasB = up(1, this.texB, vb);
    gl.uniform1f(this.u.hasA, hasA ? 1 : 0);
    gl.uniform1f(this.u.hasB, hasB ? 1 : 0);
    gl.uniform1f(this.u.alphaB, v2 ? v2Alpha(v2, t) : 0);
    gl.uniform1f(this.u.brightA, v1 ? v1Brightness(v1, this.tl, t) : 0);
    gl.uniform1f(this.u.brightAll, this.tl.duration ? globalBrightness(this.tl, t) : 1);
    gl.uniform1f(this.u.lutOn, this.lutOn && this.lutSize ? 1 : 0);
    gl.uniform1f(this.u.lutSize, this.lutSize || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    for (const v of this.videos.values()) { v.pause(); v.removeAttribute('src'); v.load(); }
    this.videos.clear();
  }
}
