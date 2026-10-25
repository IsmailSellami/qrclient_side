import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

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
