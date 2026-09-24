const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  await c.query(`ALTER TABLE "loyalty_rewards"
    ADD COLUMN IF NOT EXISTS "product_id" VARCHAR(100)`);
  console.log('product_id column ensured');
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'loyalty_rewards' ORDER BY ordinal_position`
  );
  console.log('LOYALTY_REWARDS COLS:', cols.rows.map(r => r.column_name).join(', '));
  await c.end();
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
