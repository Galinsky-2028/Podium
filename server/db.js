import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
export const pool = new Pool({
  connectionString: url,
  ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined,
  max: 6,
});

export const q = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL DEFAULT 'Untitled speech',
      doc JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS source_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT, size INT, text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS media (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, size BIGINT NOT NULL DEFAULT 0, chunks INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS media_chunks (
      media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      idx INT NOT NULL, data BYTEA NOT NULL,
      PRIMARY KEY (media_id, idx)
    );
    CREATE TABLE IF NOT EXISTS clips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shot_id TEXT NOT NULL,
      kind TEXT NOT NULL,            -- aroll | broll
      provider TEXT NOT NULL,        -- heygen | grok | mock | upload
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued', -- queued | processing | ingesting | ready | failed
      provider_job_id TEXT, remote_url TEXT, error TEXT,
      media_id UUID REFERENCES media(id) ON DELETE SET NULL,
      thumb_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
      duration REAL, attempts INT NOT NULL DEFAULT 0,
      next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS clips_project ON clips(project_id);
    CREATE INDEX IF NOT EXISTS clips_status ON clips(status);
    CREATE TABLE IF NOT EXISTS exports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0,
      options JSONB NOT NULL DEFAULT '{}'::jsonb,
      media_id UUID REFERENCES media(id) ON DELETE SET NULL, error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS custom_luts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size INT NOT NULL, data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Anything interrupted by a restart gets picked back up by the worker.
  await q(`UPDATE clips SET next_poll_at=now(),
      status = CASE WHEN provider='mock' THEN 'queued' WHEN provider='upload' THEN 'failed' ELSE 'processing' END,
      error  = CASE WHEN provider='upload' THEN 'Server restarted during upload processing; please upload again.' ELSE error END
    WHERE status='ingesting'`);
  await q(`UPDATE exports SET status='queued' WHERE status='running'`);
}
