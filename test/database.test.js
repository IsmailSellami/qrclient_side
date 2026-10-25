import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { getConnectionString, pool } from '../server/database.js';
import { createShutdown } from '../serveur.js';

test('Supabase session URL selects transaction pooling without changing credentials or options', () => {
  const original = new URL('postgresql://app.project:p%40ss@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require');
  const actual = new URL(getConnectionString(original.toString()));
  assert.equal(actual.port, '6543');
  actual.port = '5432';
  assert.equal(actual.toString(), original.toString());
});

test('direct, custom and existing transaction endpoints are preserved', () => {
  for (const url of [
    'postgresql://user:password@db.project.supabase.co:5432/postgres',
    'postgresql://user:password@localhost:5432/test',
    'postgresql://user:password@custom.pooler.supabase.com.example:5432/test',
    'postgresql://user:password@aws-1-eu-west-1.pooler.supabase.com:6543/postgres',
  ]) assert.equal(getConnectionString(url), url);
  assert.equal(getConnectionString(undefined), undefined);
});

test('one connection per app instance and idle errors have a handler', () => {
  assert.equal(pool.options.max, 1);
  assert.equal(pool.options.idleTimeoutMillis, 10000);
  assert(pool.listenerCount('error') > 0);
});

test('shutdown drains active HTTP work before ending the database, exactly once', async () => {
  let finishRequest;
  let ends = 0;
  const server = http.createServer((_req, res) => { finishRequest = () => res.end('done'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = http.get('http://127.0.0.1:' + server.address().port);
  const received = once(request, 'response');
  await once(server, 'request');
  const shutdown = createShutdown(server, { async end() { ends++; } });
  const first = shutdown();
  assert.equal(shutdown(), first);
  assert.equal(ends, 0);
  finishRequest();
  const [response] = await received;
  response.resume();
  await once(response, 'end');
  await first;
  assert.equal(ends, 1);
});
