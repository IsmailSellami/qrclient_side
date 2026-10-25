import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { pool } from '../server/database.js';
import vercelApp from '../api/index.js';
import { app as localApp } from '../serveur.js';

// SQL boundary stub: persist receipt/line/point writes, including rollback.
// No test connects to or modifies the configured customer database.
class Database {
  constructor({ percent = 20, minimum = 0, points = 100, reward = null, visit = false, visitRow = null } = {}) {
    Object.assign(this, { percent, minimum, points, reward, visit, visitRow });
    this.receipt = null;
    this.lines = [];
    this.visits = 0;
    this.claimed = false;
    this.notifications = 0;
    this.connections = 0;
    this.visitRewards = 0;
    this.promotionQueries = 0;
  }
  async connect() { this.connections++; return this; }
  release() {}
  async query(sql, args = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    const result = rows => ({ rows, rowCount: rows.length });
    if (q === 'BEGIN') {
      this.snapshot = structuredClone({ receipt: this.receipt, lines: this.lines, points: this.points, claimed: this.claimed, visits: this.visits });
      return result([]);
    }
    if (q === 'ROLLBACK') { Object.assign(this, this.snapshot); return result([]); }
    if (/^(COMMIT|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(q)) return result([]);
    if (q.startsWith('SELECT idname, price FROM product')) return result(args[0].filter(n => ['coffee', 'cake', 'fraction'].includes(n)).map(idname => ({ idname, price: { coffee: 10, cake: 4, fraction: 1.03 }[idname] })));
    if (q.includes('FROM promotion')) { this.promotionQueries++; return result(this.percent ? [{ discount_percent: this.percent, minimum_purchase_amount: this.minimum }] : []); }
    if (q.includes('FROM qr_code WHERE token')) return result([{ id: 1, token: 'a'.repeat(24), status: 'active', name: 'Test', points: this.points }]);
    if (q.includes('FROM customer_rewards cr')) return result(this.reward && !this.claimed ? [{ id: 3, ...this.reward }] : []);
    if (q.startsWith('UPDATE customer_rewards')) { this.claimed = true; return result([]); }
    if (q.includes('FROM loyalty_rewards')) return result(this.visit ? [{ id: 5, required_visits: 2, name: 'Reward' }] : []);
    if (q.startsWith('INSERT INTO system_state')) return result([]);
    if (q.includes('FROM customer_visits')) return result(this.visitRow ? [this.visitRow] : []);
    if (q.startsWith('INSERT INTO customer_visits')) { this.visits++; return result([]); }
    if (q.startsWith('UPDATE customer_visits SET order_count')) { this.visits++; return result([{ order_count: 2 }]); }
    if (q.startsWith('INSERT INTO customer_rewards')) { this.visitRewards++; return result([{ id: 9 }]); }
    if (q.startsWith('UPDATE customer_visits SET reward') || q.startsWith('UPDATE qr_code SET visit_count')) return result([]);
    if (q.startsWith('SELECT name, phone FROM qr_code')) return result([{ name: 'Test', phone: '20123456' }]);
    if (q.startsWith('SELECT idrecu FROM recu')) return result(this.receipt ? [{ idrecu: 7 }] : []);
    if (q.startsWith('INSERT INTO recu')) { this.receipt = { total: args[1] }; return result([{ idrecu: 7 }]); }
    if (q.startsWith('UPDATE recu SET totale=totale+')) { this.receipt.total = Math.round((this.receipt.total + args[0]) * 100) / 100; return result([]); }
    if (q.startsWith('INSERT INTO orderr')) { this.lines.push({ price: args[6], card: q.includes("'oui'") }); return result([]); }
    if (q.startsWith('UPDATE qr_code SET points')) { this.points -= args[0]; return result([]); }
    if (q.startsWith('UPDATE recu SET payment_method')) {
      if (!this.receipt) return result([]);
      this.receipt.method = q.includes("'cash'") ? 'cash' : 'loyalty_card';
      this.receipt.discount = this.receipt.method === 'cash' ? null : args[0];
      if (this.receipt.method === 'cash') this.receipt.total = this.lines.reduce((sum, l) => sum + l.price, 0);
      return result([{ totale: this.receipt.total }]);
    }
    if (q.startsWith('INSERT INTO notifications')) { this.notifications++; return result([]); }
    throw new Error('Unexpected SQL: ' + q);
  }
}

let db;
pool.connect = async () => db.connect();
pool.query = (...args) => db.query(...args);

for (const [name, app] of [['local', localApp], ['Vercel', vercelApp]]) {
  test(name + ' checkout routes persist correct charges', async t => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    t.after(() => new Promise(resolve => server.close(resolve)));
    async function post(path, body) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, ...await response.json() };
    }
    const order = { numtable: 60, items: [{ idname: 'coffee' }], totale: 10 };
    const card = { ...order, qrId: 'a'.repeat(24), total: 10 };
    for (const percent of [0, 20]) {
      await t.test('cash stays 10 with promotion ' + percent + '% and forged browser totals', async () => {
        db = new Database({ percent });
        const created = await post('/demander', { ...order, totale: 8 });
        assert.equal(created.total, 10);
        const paid = await post('/process-cash-payment', { idrecu: created.idrecu, total: 6.4 });
        assert.equal(paid.total, 10);
        assert.equal(db.receipt.total, 10);
        assert.equal(db.receipt.discount, null);
        assert.equal(db.lines[0].price, 10);
        assert.equal(db.points, 100);
        assert.equal(db.visits, 0);
        assert.equal(db.promotionQueries, 0);
      });
      await t.test('card charge with promotion ' + percent + '%', async () => {
        db = new Database({ percent, visit: true });
        const paid = await post('/process-card-payment', { ...card, total: 1 });
        const expected = percent ? 8 : 10;
        assert.equal(paid.total, expected);
        assert.equal(db.receipt.total, expected);
        assert.equal(db.lines[0].price, expected);
        assert.equal(db.points, 100 - expected);
        assert.equal(db.visits, 1);
      });
    }
    await t.test('minimum purchase gates the card promotion', async () => {
      db = new Database({ minimum: 11 });
      assert.equal((await post('/process-card-payment', card)).total, 10);
    });
    await t.test('return visit still grants the threshold reward and notification', async () => {
      db = new Database({ visit: true, visitRow: { id: 4, reward: false } });
      assert.equal((await post('/process-card-payment', card)).success, true);
      assert.equal(db.visits, 1);
      assert.equal(db.visitRewards, 1);
      assert.equal(db.notifications, 2); // reward plus payment confirmation
      assert.equal(db.connections, 1); // no second pool slot while card is locked
    });
    await t.test('already rewarded visits do not grant a second reward', async () => {
      db = new Database({ visit: true, visitRow: { id: 4, reward: true } });
      assert.equal((await post('/process-card-payment', card)).success, true);
      assert.equal(db.visits, 0);
      assert.equal(db.visitRewards, 0);
    });
    await t.test('earned discount replaces promotion and is checked before balance', async () => {
      db = new Database({ points: 6, reward: { reward_type: 'discount', discount_percent: 50 } });
      assert.equal((await post('/process-card-payment', { ...card, rewardId: 3 })).total, 5);
      assert.equal(db.points, 1);
      assert.equal(db.claimed, true);
    });
    await t.test('free item excluded from promotion threshold and persisted at zero', async () => {
      db = new Database({ minimum: 12, reward: { reward_type: 'free_item', product_id: 'cake' } });
      const paid = await post('/process-card-payment', { ...card, items: [...card.items, { idname: 'cake' }], rewardId: 3 });
      assert.equal(paid.total, 10);
      assert.deepEqual(db.lines.map(l => l.price), [10, 0]);
    });
    await t.test('new card charge preserves earlier cash receipt amount', async () => {
      db = new Database();
      await post('/demander', order);
      await post('/process-card-payment', card);
      assert.equal(db.receipt.total, 18);
      assert.deepEqual(db.lines.map(l => l.price), [10, 8]);
    });
    await t.test('rounding matches sum of stored lines and point debit', async () => {
      db = new Database();
      const paid = await post('/process-card-payment', { ...card, items: [{ idname: 'fraction' }, { idname: 'fraction' }] });
      assert.equal(paid.total, 1.64);
      assert.equal(db.receipt.total, 1.64);
      assert.deepEqual(db.lines.map(l => l.price), [0.82, 0.82]);
    });
    await t.test('insufficient balance rolls back reward, receipt and visit', async () => {
      db = new Database({ points: 1, visit: true, reward: { reward_type: 'discount', discount_percent: 50 } });
      assert.equal((await post('/process-card-payment', { ...card, rewardId: 3 })).error, 'INSUFFICIENT_POINTS');
      assert.equal(db.receipt, null);
      assert.equal(db.visits, 0);
      assert.equal(db.claimed, false);
    });
    await t.test('unknown product fails without saving a partial order', async () => {
      db = new Database();
      assert.equal((await post('/demander', { ...order, items: [{ idname: 'unknown' }] })).status, 400);
      assert.equal(db.receipt, null);
    });
    await t.test('invalid QR verification total returns 400', async () => {
      assert.equal((await post('/verify-qr', { qrId: card.qrId, total: 'invalid' })).status, 400);
    });
    await t.test('static files, redirect and location remain accessible', async () => {
      for (const path of ['/', '/css/styles.css', '/js/script.js']) assert.equal((await fetch(base + path)).status, 200);
      assert.equal((await fetch(base + '/loyalty/' + card.qrId, { redirect: 'manual' })).status, 301);
      assert.equal((await post('/verify-location', {})).authorized, true);
    });
  });
}
