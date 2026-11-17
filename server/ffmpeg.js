import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const OUT_W = 1920;
export const OUT_H = 1080;
export const FPS = 30;
const THREADS = process.env.FFMPEG_THREADS || '2';
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) =>
  fs.existsSync(f),
);

export function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err = (err + s).slice(-8000);
      onStderr && onStderr(s);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-1500)}`))));
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(j.format.duration || v?.duration || '0'),
    width: v?.width, height: v?.height, hasAudio: !!a, hasVideo: !!v,
  };
}

const scalePad = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}`;

// Normalize any source clip to 1080p30 H.264/AAC with an audio track (silent if none).
export async function normalize(input, output, { keepAudio = true } = {}) {
  const info = await probe(input);
  if (!info.hasVideo) throw new Error('Downloaded file has no video stream');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (!info.hasAudio || !keepAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-map', '0:v:0', '-map', info.hasAudio && keepAudio ? '0:a:0' : '1:a:0', '-shortest');
  args.push('-vf', `${scalePad},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-threads', THREADS);
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output);
  await run('ffmpeg', args);
  return probe(output);
}

export async function thumbnail(input, output, at = 0.5) {
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', output]);
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%');
function wrap(text, n = 46, maxLines = 4) {
  const words = text.split(/\s+/);
  const lines = [''];
  for (const w of words) {
    if ((lines[lines.length - 1] + ' ' + w).trim().length > n) lines.push(w);
    else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim();
  }
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += ' …'; }
  return lines;
}

// Demo-mode placeholder clip (used when a provider key isn't configured yet).
export async function placeholderClip(output, { kind, label, text, seconds, seed = 0 }) {
  const hue = (seed * 47) % 360;
  const color = kind === 'aroll' ? '0x1c2a44' : `0x${['3a2a1c', '1c3a2a', '2a1c3a', '3a1c24', '1c343a'][seed % 5]}`;
  const lines = wrap(text || label || '', 48);
  const draw = [];
  if (FONT) {
    draw.push(`drawtext=fontfile=${FONT}:text='${esc(label)}':x=60:y=50:fontsize=44:fontcolor=white@0.9`);
    lines.forEach((l, i) =>
      draw.push(`drawtext=fontfile=${FONT}:text='${esc(l)}':x=(w-text_w)/2:y=h/2-${(lines.length * 60) / 2 - i * 60}:fontsize=46:fontcolor=white`),
    );
    draw.push(`drawtext=fontfile=${FONT}:text='DEMO PLACEHOLDER  %{pts\\:hms}':x=60:y=h-90:fontsize=30:fontcolor=white@0.6`);
  }
  const src = kind === 'aroll'
    ? `color=c=${color}:s=${OUT_W}x${OUT_H}:r=${FPS}:d=${seconds}`
    : `gradients=s=${OUT_W}x${OUT_H}:r=${FPS}:d=${seconds}:c0=0x${color.slice(2)}:c1=0x8a6a3a:speed=0.02:seed=${seed}`;
  const audio = kind === 'aroll'
    ? `sine=f=${180 + (hue % 60)}:r=48000:d=${seconds},volume=0.05,aformat=channel_layouts=stereo`
    : `anullsrc=r=48000:cl=stereo`;
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', audio,
    '-vf', [...draw, 'format=yuv420p'].join(','), '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-threads', THREADS,
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output,
  ]);
}
