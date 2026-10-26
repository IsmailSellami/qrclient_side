import 'dotenv/config';
import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { getPoolOptions } from '../server/database.js';
// Read-only authorization probes. No rows returned, no DML or RPC execution.
const verified = process.env.AUDIT_UNVERIFIED_TLS !== '1';
if (!verified) console.error('READ-ONLY AUDIT: server TLS identity is unverified.');
const connection = getPoolOptions(process.env.DATABASE_URL);
const db = new pg.Client({ ...connection, ssl: { ...connection.ssl, rejectUnauthorized: verified }, connectionTimeoutMillis: 10000 });
try {
  await db.connect();
  const results = [];
  for (const role of ['anon','authenticated']) {
    for (const table of ['qr_code','customer_orders','customer_rewards','customer_challenges','customer_visits','point_today','users','whatssup_session','orderr','recu','storage.objects']) {
      await db.query('BEGIN READ ONLY');
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query('SET LOCAL ROLE ' + role);
      try {
        const r = await db.query('SELECT EXISTS (SELECT 1 FROM ' + (table.includes('.') ? table : 'public.' + table) + ') AS visible');
        results.push({ role, table, readAllowed: true, existingRowsVisible: r.rows[0].visible });
      } catch (error) { results.push({ role, table, readAllowed: false, code: error.code }); }
      await db.query('ROLLBACK');
    }
  }
  const funcs = await db.query("SELECT proname, pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'");
  const secretWarnings = [];
  for (const f of funcs.rows) {
    if (f.proname === 'use_reward') await writeFile('artifacts/use-reward-review.sql', f.body);
    const patterns = [/sb_secret_/i, /bearer\s+[A-Za-z0-9._-]{12,}/i, /https?:\/\/[^\s'"]+/i, /authorization/i];
    if (patterns.some(p=>p.test(f.body))) secretWarnings.push({ function: f.proname, requiresCredentialReview: true });
  }
  console.log(JSON.stringify({ results, secretWarnings },null,2));
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/access-audit.json',JSON.stringify({results,secretWarnings},null,2));
} catch(error) { console.error('Read-only probe failed:',error.code || error.name);process.exitCode=1; }
finally { await db.end(); }
