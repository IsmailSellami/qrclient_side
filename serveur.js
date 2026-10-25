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
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('error', reject);
    server.once('listening', () => {
      console.log('Server is running on port ' + port);
      resolve(server);
    });
  });
}

export function createShutdown(server, database = pool) {
  let pending;
  return () => {
    if (!pending) pending = (async () => {
      try {
        await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      } finally {
        await database.end();
      }
    })();
    return pending;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(server => {
    const shutdown = createShutdown(server);
    const signals = ['SIGINT', 'SIGTERM'];
    if (process.platform !== 'win32') signals.push('SIGUSR2');
    for (const signal of signals) {
      process.once(signal, () => {
        const deadline = setTimeout(() => process.exit(1), 10000);
        deadline.unref();
        shutdown().then(() => {
          clearTimeout(deadline);
          if (signal === 'SIGUSR2') process.kill(process.pid, signal);
          else process.exit(0);
        }).catch(err => {
          console.error('Server shutdown failed:', err.message);
          process.exit(1);
        });
      });
    }
  }).catch(async err => {
    console.error('Database connection failed:', err.message);
    await pool.end();
    process.exitCode = 1;
  });
}
