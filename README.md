# Podium

Campaign speech video studio for Galinsky 2028. You give it a brief plus any source files (bill text, policy memos) and it handles the rest automatically. Every step stays editable.

1. **Speech.** Claude writes the speech from your brief and documents. You can edit it by hand or ask for revisions.
2. **Shot list.** Claude acts as director. It splits the speech into on-camera segments, varies framing across your HeyGen "looks", plans b-roll cutaways with text-to-video prompts, and picks a color grade.
3. **Clips.** HeyGen renders you speaking each segment. Grok Imagine renders the b-roll. A background worker submits and polls the jobs, then downloads and normalizes each clip to 1080p30. Jobs survive restarts.
4. **Auto-edit.** The timeline is built from the shot list:
   - V1 holds the candidate.
   - V2 holds b-roll with cross-fades over the candidate's continuing voice.
   - Section changes get a dip to black.
   - The video fades from and to black.
   - A color adjustment layer applies a LUT.
5. **Editor.** This is a simplified Premiere-style editor with a live WebGL preview and the LUT applied in real time. You can:
   - Click any clip, say what's wrong, and get a regenerated version. Claude rewrites the prompt or framing, and old versions stay in a version history.
   - Drag or resize b-roll, change trims, fades and transitions.
   - Add b-roll at the playhead, or upload your own footage for any shot.
6. **Color.** There are 27 built-in looks (film print, teal & orange, bleach bypass, mono, day-for-night and more) plus knobs for intensity, exposure, contrast, highlights, shadows, temperature, tint, saturation, vibrance and fade. You can also import any `.cube` file, including the Lumetri LUTs that ship with Premiere Pro.
7. **Export.** ffmpeg renders the same timeline and the same baked LUT to an MP4 at 1080p or 720p.

Edits are stored as overrides on each shot, and the timeline is re-derived from them. That lets you regenerate a clip or change a line without losing your trims and fades.

## Setup

Open **Settings** in the app:

- **Anthropic API key**: speechwriting, shot planning and revisions. Default model is `claude-opus-5-5`.
- **HeyGen API key**: click "Load my avatars & voices", choose your voice, and add one look per avatar or framing you created in HeyGen.
- **xAI API key**: Grok Imagine b-roll. The model, resolution and a style suffix for every prompt are configurable.

If a key is missing, that stage runs in **demo mode** and produces placeholder clips, so you can still try the whole flow.

## Running

```bash
npm install
DATABASE_URL=postgres://... APP_PASSWORD=secret npm run dev   # API :3000 + Vite :5173
npm run build && npm start                                    # production
npm test
```

Environment variables:

- `DATABASE_URL` (required): Postgres. Neon works.
- `APP_PASSWORD`: shared login password. If it is unset, the app is open to anyone.
- `SESSION_SECRET`
- `ANTHROPIC_API_KEY`, `HEYGEN_API_KEY`, `XAI_API_KEY`: optional alternatives to entering the keys in Settings.
- `FFMPEG_THREADS`, `MAX_INGEST`

Media is stored in Postgres in chunks so it survives restarts on hosts without a persistent disk, with a local disk cache for streaming. The Docker image includes ffmpeg.

## Layout

- `shared/`: timeline derivation and the color engine. Both the browser preview and the server export use this code, so the preview matches the export.
- `server/`: Express API, Claude prompts (`llm.js`), HeyGen and Grok (`providers.js`), job worker (`jobs.js`), ffmpeg export (`export.js`).
- `src/`: React UI. The editor lives in `src/editor/`.
