import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migration locks down every inspected public relation and elevated RPC in isolated PostgreSQL', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;`);
    // All 23 relation names from the read-only production metadata inventory.
    const tables = ['categorie','customer_challenges','customer_orders','customer_rewards','customer_visits',
      'daily_stats','en_cour','loyalty_challenges','loyalty_recharge_packages','loyalty_rewards',
      'notifications','orderr','point_today','product','promotion','qr_code','recu','statistique',
      'system_state','tablee','users','whatssup_session'];
    for(const name of tables) await db.exec(`CREATE TABLE public.${name}(id serial PRIMARY KEY, value text); INSERT INTO ${name}(value) VALUES ('private');`);
    await db.exec(`CREATE VIEW notification_last_activity AS SELECT * FROM notifications;
      CREATE FUNCTION public.use_reward(bigint,text,text,text,text) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT value FROM public.qr_code LIMIT 1 $$;
      CREATE FUNCTION public.bump_whatsapp_usage(text,integer) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.notify_worker_of_new_notification() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;`);
    await db.exec('GRANT CREATE ON SCHEMA public TO anon, authenticated');
    const rollback=await readFile(new URL('../migrations/20261026_security_down.sql',import.meta.url),'utf8');
    for(const match of rollback.matchAll(/ON SEQUENCE public\."([^"]+)"/g)) await db.exec(`CREATE SEQUENCE IF NOT EXISTS public."${match[1]}";`);
    const before = await db.query("SELECT has_table_privilege('anon','qr_code','SELECT') AS exposed");
    assert.equal(before.rows[0].exposed,true);
    await db.exec(await readFile(new URL('../migrations/20261026_security_up.sql',import.meta.url),'utf8'));
    for(const role of ['anon','authenticated']) {
      for(const name of [...tables,'notification_last_activity']) {
        await db.exec('SET ROLE '+role);
        for(const sql of [`SELECT * FROM ${name}`,`UPDATE ${name} SET value='forged'`,`DELETE FROM ${name}`,`INSERT INTO ${name}(value) VALUES ('forged')`]) {
          await assert.rejects(db.query(sql),e=>e.code==='42501',role+' must not access '+name);
        }
        await db.exec('RESET ROLE');
      }
      await db.exec('SET ROLE '+role);
      await assert.rejects(db.query('CREATE TABLE public.attacker_table(id integer)'),e=>e.code==='42501');
      await assert.rejects(db.query("SELECT public.use_reward(1,null,null,null,null)"),e=>e.code==='42501');
      await assert.rejects(db.query('SELECT * FROM app_private.checkout_requests'),e=>e.code==='42501');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE app_server');
    assert.equal((await db.query('SELECT * FROM qr_code')).rows.length,1);
    await db.query("UPDATE qr_code SET value='authorized'");
    await assert.rejects(db.query('SELECT * FROM users'),e=>e.code==='42501');
    await assert.rejects(db.query('SELECT * FROM whatssup_session'),e=>e.code==='42501');
    await db.query("INSERT INTO app_private.checkout_requests(scope,key,principal,digest,response) VALUES ('card','k','u','d','{}')");
    await db.exec('RESET ROLE');
    // Public future tables and functions created by postgres stay inaccessible.
    await db.exec("CREATE TABLE future_private(id integer); CREATE FUNCTION future_rpc() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;");
    assert.equal((await db.query("SELECT has_table_privilege('anon','future_private','SELECT') AS allowed")).rows[0].allowed,false);
    assert.equal((await db.query("SELECT has_function_privilege('anon','future_rpc()','EXECUTE') AS allowed")).rows[0].allowed,false);
    // Actual shared-store statement atomically increments across app instances.
    const { distributedLimit } = await import('../server/security.js');
    const pool={query:async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length};}};
    let accepted=0,limited=0;
    const limit=distributedLimit(pool,'test',2,60,()=> 'same-card');
    for(let i=0;i<4;i++) await limit({}, {set(){},status(code){assert.equal(code,429);limited++;return this;},json(){}},()=>accepted++);
    assert.equal(accepted,2);assert.equal(limited,2);
    await db.exec(rollback);
    assert.equal((await db.query("SELECT has_table_privilege('anon','qr_code','SELECT') AS restored")).rows[0].restored,true);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM app_private.checkout_requests')).rows[0].n,1);
    await db.exec(`ALTER TABLE product ADD COLUMN idname text, ADD COLUMN price numeric, ADD COLUMN archived boolean DEFAULT false;
      INSERT INTO product(idname,price,archived) VALUES ('coffee',10,false),('archived',1,true);`);
    const { loadPrices } = await import('../server/pricing.js');
    assert.equal((await loadPrices(pool,[{idname:'coffee',price:0.01}])).get('coffee'),10);
    await assert.rejects(loadPrices(pool,[{idname:'archived'}]),/INVALID_PRODUCT/);
  } finally { await db.close(); }
});
