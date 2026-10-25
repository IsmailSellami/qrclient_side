import 'dotenv/config';
import dns from 'node:dns';
import { pathToFileURL } from 'node:url';
import { createApp } from './server/app.js';
import { pool, supabase, initializeLocalDatabase } from './server/database.js';

dns.setDefaultResultOrder('verbatim');
const port = process.env.PORT || 3991;
export const app = createApp({ pool, supabase, local: true, port });

export async function startServer() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  await initializeLocalDatabase();
  const server = app.listen(port, () => console.log('Server is running on port ' + port));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(async err => {
    console.error('Database connection failed:', err.message);
    await pool.end();
    process.exitCode = 1;
  });
}
