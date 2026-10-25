import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

export function getConnectionString(connectionString) {
  if (!connectionString) return connectionString;
  const url = new URL(connectionString);
  // This app uses explicit transactions and unnamed queries, with no session
  // state. Share backend connections instead of reserving a session per client.
  if (url.hostname.endsWith('.pooler.supabase.com') && (!url.port || url.port === '5432')) {
    url.port = '6543';
    return url.toString();
  }
  return connectionString;
}

export const pool = new pg.Pool({
  connectionString: getConnectionString(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true,
});

// pg removes the failed idle client; a later query can open a new connection.
pool.on('error', err => console.error('Idle database connection failed:', err.message));

export const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

// Preserve the local server's additive schema setup. Never drop existing data.
export async function initializeLocalDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS qr_code (
    id TEXT PRIMARY KEY,
    points NUMERIC(10,3) NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT ''
  )`);
  await pool.query("ALTER TABLE orderr ADD COLUMN IF NOT EXISTS paid TEXT DEFAULT 'non'");
  await pool.query('ALTER TABLE orderr ADD COLUMN IF NOT EXISTS prix NUMERIC(10,2)');
  await pool.query('ALTER TABLE promotion ADD COLUMN IF NOT EXISTS minimum_purchase_amount NUMERIC(10,2) DEFAULT 0');
}
