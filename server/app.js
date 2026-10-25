import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrices, baseTotal, linePrice, promotionPercent } from './pricing.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp({ pool, supabase = null, local = false, port = 3991 }) {
  const app = express();

  /* ───── Environment ───── */

  const LOYALTY_APP_URL = process.env.LOYALTY_APP_URL || 'https://qrcode-client-alpha.vercel.app';

  /* ───── Security helpers ───── */

  function isSameOrigin(req) {
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const host = req.headers['host'];
    if (!host) return false;
    if (origin && (origin === `http://${host}` || origin === `https://${host}`)) return true;
    if (referer) {
      try {
        const u = new URL(referer);
        if (u.host === host) return true;
      } catch { }
    }
    return !origin && !referer;
  }

  function csrfProtection(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!isSameOrigin(req)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    next();
  }

  /* ───── Middlewares ───── */

  app.use(cors({
    origin: local ? (origin, cb) => cb(null, !origin || [
      `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    ].includes(origin) || /^http:\/\/(192\.168\.|10\.)/.test(origin)) : true,
    credentials: local,
  }));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://ewciynnuevuzbcrwcjut.supabase.co", "https://i.postimg.cc"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: local ? null : [],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  const globalLimiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Trop de requêtes' },
  });
  app.use(globalLimiter);

  const paymentLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Trop de requêtes' },
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use('/css', express.static(path.join(publicDir, 'css')));
  app.use('/js', express.static(path.join(publicDir, 'js')));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  /* ───── Public Loyalty Endpoints (before CSRF) ───── */

  // loyalty token lookup (public)
  app.get('/api/loyalty/token/:token', async (req, res) => {
    try {
      const raw = req.params.token;
      if (!raw || raw.length < 24) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      const result = await pool.query(
        'SELECT id, name, phone, points, status, assigned_at, lifetime_points FROM qr_code WHERE token = $1',
        [raw]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      const card = result.rows[0];
      if (card.status !== 'active') {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      res.json({
        id: card.id,
        name: card.name || '',
        phone: card.phone || '',
        points: Number(card.points || 0),
        status: card.status || 'active',
        assignedAt: card.assigned_at,
        lifetimePoints: Number(card.lifetime_points || 0),
      });
    } catch (err) {
      console.error('GET /api/loyalty/token/:token error:', err);
      res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  });

  // loyalty config (public — packages, rewards for customer-facing UI)
  // Note: loyalty_tiers was removed from the current schema (no tier system);
  // tiers are returned as an empty list so callers degrade gracefully.
  app.get('/api/loyalty/public/config', async (_req, res) => {
    try {
      const [packagesResult, rewardsResult, challengesResult] = await Promise.all([
        pool.query('SELECT id, amount, base_points AS "basePoints", bonus_points AS "bonusPoints", total_points AS "totalPoints", label, is_promotional AS "isPromotional", starts_at AS "startsAt", ends_at AS "endsAt" FROM loyalty_recharge_packages WHERE is_active = true ORDER BY amount ASC'),
        pool.query('SELECT id, name, description, required_points AS "requiredPoints", reward_type AS "rewardType", discount_percent AS "discountPercent", product_id AS "productId" FROM loyalty_rewards WHERE is_active = true AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at >= NOW()) ORDER BY required_points ASC'),
        pool.query('SELECT id, name, description, challenge_type AS "challengeType", target, bonus_points AS "bonusPoints", start_date AS "startDate", end_date AS "endDate" FROM loyalty_challenges WHERE is_active = true AND start_date <= NOW() AND end_date >= NOW() ORDER BY end_date ASC'),
      ]);

      res.json({
        tiers: [],
        packages: packagesResult.rows,
        rewards: rewardsResult.rows,
        challenges: challengesResult.rows,
      });
    } catch (err) {
      console.error('GET /api/loyalty/public/config error:', err);
      res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  });

  // loyalty customer full info (public — card + tier + rewards + challenges for QR viewer)
  app.get('/api/loyalty/public/customer/:token', async (req, res) => {
    try {
      const { token } = req.params;
      if (!token || token.length < 24) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      const cardResult = await pool.query(
        'SELECT id, name, phone, points, status, lifetime_points, visit_count, assigned_at FROM qr_code WHERE token = $1',
        [token]
      );
      if (cardResult.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }
      const card = cardResult.rows[0];
      if (card.status !== 'active') {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      const cardId = card.id;

      // Tier info: the legacy loyalty_tiers table no longer exists in the current
      // schema, so no tier/next-tier is reported (frontend degrades to default).
      const tier = null;
      const nextTier = null;
      const lifetime = Number(card.lifetime_points || 0);

      // Rewards — R5: an earned reward is the customer's permanently. The catalog
      // row's is_active / starts_at / ends_at gate UNLOCK, never visibility, so
      // they are deliberately NOT in this WHERE clause. isExpired is a label the
      // UI uses to grey the chip out; the claim stays selectable and redeemable.
      const rewardsResult = await pool.query(
        `SELECT cr.id, cr.mystery_result AS "mysteryResult", cr.is_redeemed AS "isRedeemed", cr.earned_at AS "earnedAt", cr.redeemed_at AS "redeemedAt",
                lr.name AS "rewardName", lr.reward_type AS "rewardType", lr.trigger_type AS "triggerType",
                lr.required_points AS "requiredPoints", lr.required_visits AS "requiredVisits",
                lr.discount_percent AS "discountPercent", lr.product_id AS "productId", lr.ends_at AS "endsAt",
                (lr.ends_at IS NOT NULL AND lr.ends_at < NOW()) AS "isExpired"
         FROM customer_rewards cr
         JOIN loyalty_rewards lr ON lr.id = cr.reward_id
         WHERE cr.qr_code_id = $1
         ORDER BY cr.earned_at DESC`,
        [cardId]
      );

      // Active challenges
      const challengesResult = await pool.query(
        `SELECT cc.id, cc.progress, cc.completed_at AS "completedAt", cc.bonus_awarded AS "bonusAwarded",
                lc.name AS "challengeName", lc.challenge_type AS "challengeType", lc.target, lc.bonus_points AS "bonusPoints"
         FROM customer_challenges cc
         JOIN loyalty_challenges lc ON lc.id = cc.challenge_id
         WHERE cc.qr_code_id = $1 AND cc.completed_at IS NULL
         ORDER BY lc.end_date ASC`,
        [cardId]
      );

      // Monthly stats (current month): the permanent loyalty_transactions ledger
      // was removed; point_today (per daily recharge record) is the replacement.
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthDate = monthStart.toISOString().slice(0, 10);
      const monthlyResult = await pool.query(
        `SELECT COUNT(*) AS "transactions", COALESCE(SUM(points), 0) AS "pointsEarned"
         FROM point_today
         WHERE qr_code_id = $1 AND date >= $2`,
        [cardId, monthDate]
      );

      res.json({
        card: {
          id: card.id,
          name: card.name,
          phone: card.phone,
          points: Number(card.points || 0),
          lifetimePoints: lifetime,
          visitCount: Number(card.visit_count || 0),
          assignedAt: card.assigned_at,
        },
        tier,
        nextTier,
        pointsToNextTier: 0,
        monthlySpent: Number(monthlyResult.rows[0]?.transactions || 0),
        monthlyPointsEarned: Number(monthlyResult.rows[0]?.pointsEarned || 0),
        rewards: rewardsResult.rows,
        activeChallenges: challengesResult.rows,
      });
    } catch (err) {
      console.error('GET /api/loyalty/public/customer/:token error:', err);
      res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  });

  /* ───── Customer visits (per-card counter) ───── */

  // Visits are a per-customer counter kept in `customer_visits`, keyed by
  // qr_code_id. A visit is counted the moment the customer pays with their
  // loyalty card, and a reward is granted when the counter reaches the active
  // visit reward's `required_visits`. Both entry points share this implementation.
  /**
   * The single active visit reward, if any. recomponce01.md §3.1: the source of
   * truth is `trigger_type='visits'` + active + NOW() inside the window. Overlap
   * prevention (loyalty routes) guarantees at most one; if more ever slip in,
   * the lowest threshold wins deterministically.
   */
  async function getActiveVisitReward(db) {
    const result = await db.query(
      `SELECT id, name, required_visits, ends_at FROM loyalty_rewards
        WHERE is_active = true AND trigger_type = 'visits'
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
        ORDER BY required_visits ASC NULLS LAST, id ASC
        LIMIT 1`
    );
    return result.rowCount > 0 ? result.rows[0] : null;
  }

  /**
   * recomponce01.md §3.2: detect a brand-new visit-reward cycle and clear
   * customer_visits exactly ONCE. The transition is keyed on the active reward
   * id stored in `system_state`; the conditional upsert returns a row only for the
   * caller that actually changes the id, so concurrent orders cannot double-clear.
   * Earned `customer_rewards` are never touched. Returns the active reward (or
   * null). Degrades gracefully when `system_state` is absent (migration not yet
   * applied): gating still works, only the one-time reset is skipped.
   */
  async function syncVisitRewardCycle(db) {
    const active = await getActiveVisitReward(db);
    if (!active) return null;
    try {
      await db.query('SAVEPOINT visit_cycle');
      const transitioned = await db.query(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES ('current_visit_reward_id', $1, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()
           WHERE system_state.value IS DISTINCT FROM EXCLUDED.value
         RETURNING key`,
        [String(active.id)]
      );
      await db.query(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES ('current_visit_reward_ends_at', $1, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
        [active.ends_at ? new Date(active.ends_at).toISOString() : '']
      );
      if (transitioned.rowCount > 0) {
        await db.query('DELETE FROM customer_visits');
      }
      await db.query('RELEASE SAVEPOINT visit_cycle');
    } catch (err) {
      try { await db.query('ROLLBACK TO SAVEPOINT visit_cycle'); } catch (_) {}
      if (!/system_state/i.test(String(err && err.message))) throw err;
    }
    return active;
  }

  /** Same rule as the POS server's notifyClient(): a Tunisian mobile number only. */
  function visitPhoneEligible(phone) {
    let cleaned = String(phone || '').replace(/[\s\-().]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
    if (cleaned.length === 8) cleaned = '216' + cleaned;
    return cleaned.length === 11 && cleaned.startsWith('216');
  }

  /**
   * Queue one WhatsApp message for a card. Idempotent through
   * uq_push_notifications_target (qr_code_id, category, ref_id).
   */
  async function queueVisitNotification(db, cardId, category, refId, message, templateName) {
    await db.query(
      `INSERT INTO notifications (qr_code_id, category, ref_id, message, template_name, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (qr_code_id, category, ref_id) DO NOTHING`,
      [cardId, category, refId, message, templateName],
    );
  }

  /**
   * Count a visit for the customer on a loyalty-card payment (Task 2).
   *
   * Rules, in order:
   *  1. A visit is only counted while a valid, non-expired visit reward exists.
   *     With no active reward (or an expired one) the whole reward loop stops.
   *  2. If the customer has no row in `customer_visits` yet, create it with
   *     `order_count = 1` (this first loyalty payment is their first visit) and stop.
   *     If they already own the reward for this cycle (`reward = TRUE`), stop.
   *  3. If the customer still has an open receipt with one of their orders, they
   *     have not left the cafe yet: do nothing.
   *  4. Otherwise the customer has left and come back: bump `order_count` by 1.
   *  5. When `order_count` reaches the manager's `required_visits`, grant the
   *     reward: insert into `customer_rewards` once and set `reward = TRUE`.
   *
   * Called BEFORE this payment writes its own receipt/order (see
   * /process-card-payment), so the "still at the cafe" lookup sees the customer's
   * previous open receipts, never the order being placed right now.
   * Non-fatal: a visit hiccup must never void a valid payment.
   */
  async function processVisitForCardPayment(db, cardId, clientName) {
    // 1. Is a visit reward available right now? No active (or an expired) reward
    //    means the whole reward loop stops without touching customer_visits.
    const activeReward = await syncVisitRewardCycle(db);
    if (!activeReward) return null;

    // 2. Does the customer already have a counter row?
    const existing = await db.query(
      `SELECT id, reward FROM customer_visits
        WHERE qr_code_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [cardId]
    );

    if (existing.rowCount === 0) {
      // First loyalty payment: create the counter with this visit already counted,
      // then exit immediately.
      await db.query(
        `INSERT INTO customer_visits (qr_code_id, status, order_count, reward, started_at)
         VALUES ($1, 'open', 1, false, NOW())
         ON CONFLICT DO NOTHING`,
        [cardId]
      );
      return 1;
    }

    const visit = existing.rows[0];

    // The customer already earned this cycle's reward: stop, never grant again.
    if (visit.reward === true) return null;

    // 3. Is the customer still at the cafe? An open receipt that already carries
    //    one of their orders means they have not left yet, so this is not a new visit.
    const atCafe = await db.query(
      `SELECT idrecu FROM recu
        WHERE heurf IS NULL
          AND idrecu IN (SELECT idrecu FROM orderr WHERE nom_ut = $1)
        LIMIT 1`,
      [clientName]
    );
    if (atCafe.rowCount > 0) return null;

    // 4. They left and came back: count exactly one new visit.
    const bumped = await db.query(
      `UPDATE customer_visits SET order_count = order_count + 1
        WHERE id = $1
        RETURNING order_count`,
      [visit.id]
    );
    const orderCount = Number(bumped.rows[0].order_count);

    // 5. Threshold reached? Grant the reward once and mark the cycle as rewarded.
    const threshold = Number(activeReward.required_visits);
    if (Number.isFinite(threshold) && orderCount >= threshold) {
      const claimed = await db.query(
        `INSERT INTO customer_rewards (qr_code_id, reward_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [cardId, activeReward.id]
      );
      await db.query(
        `UPDATE customer_visits SET reward = true WHERE id = $1`,
        [visit.id]
      );
      if (claimed.rowCount > 0) {
        // Preserve the existing "you won a reward" WhatsApp notification and the
        // cumulative qr_code.visit_count display when a reward is actually granted.
        await db.query(
          `UPDATE qr_code SET visit_count = visit_count + 1 WHERE id = $1`,
          [cardId]
        );
        const card = await db.query('SELECT name, phone FROM qr_code WHERE id = $1', [cardId]);
        if (card.rowCount > 0 && visitPhoneEligible(card.rows[0].phone)) {
          const who = card.rows[0].name || clientName || 'Client';
          await queueVisitNotification(
            db, cardId, 'reward', `claim-${claimed.rows[0].id}`,
            `Bonjour ${who}, vous avez atteint ${threshold} visites et gagnez votre récompense : ${activeReward.name} !`,
            'sellamo_reward');
        }
      }
      return orderCount;
    }

    return orderCount;
  }

  // loyalty transactions (public — by token)
  // The permanent loyalty_transactions ledger was removed from the schema, so no
  // transaction history can exist. The endpoint stays for compatibility and
  // returns an empty list once a valid active card is found.
  app.get('/api/loyalty/public/transactions/:token', async (req, res) => {
    try {
      const { token } = req.params;
      if (!token || token.length < 24) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      const cardResult = await pool.query('SELECT id, status FROM qr_code WHERE token = $1', [token]);
      if (cardResult.rowCount === 0 || cardResult.rows[0].status !== 'active') {
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }

      res.json([]);
    } catch (err) {
      console.error('GET /api/loyalty/public/transactions/:token error:', err);
      res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  });

  // loyalty redeem reward (public — by token + rewardId)
  app.post('/api/loyalty/public/redeem-reward', paymentLimiter, async (req, res) => {
    const { token, rewardId } = req.body;

    if (!token || typeof token !== 'string' || token.length < 24) {
      return res.status(400).json({ success: false, error: 'TOKEN_REQUIRED' });
    }
    const rewardIdNum = Number(rewardId);
    if (isNaN(rewardIdNum) || rewardIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'REWARD_REQUIRED' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cardResult = await client.query(
        'SELECT id, status FROM qr_code WHERE token = $1 FOR UPDATE',
        [token]
      );
      if (cardResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      }
      const card = cardResult.rows[0];
      if (card.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'INACTIVE_CARD' });
      }

      // R5 / R7: entitlement is proven by the CLAIM, not by the catalog row.
      // `customer_rewards.id + qr_code_id + is_redeemed = false` is the whole
      // authorization. The two window predicates that used to sit here meant a
      // customer who earned a reward at 17:50 lost it at 18:01 and could never
      // spend it — the exact theft the binding lifecycle rule forbids. They are
      // removed: ends_at is an unlock condition, never an expiry of ownership.
      const customerReward = await client.query(
        `SELECT cr.id
         FROM customer_rewards cr
         WHERE cr.id = $1 AND cr.qr_code_id = $2 AND cr.is_redeemed = false
         FOR UPDATE`,
        [rewardIdNum, card.id]
      );
      if (customerReward.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'REWARD_NOT_FOUND' });
      }

      await client.query(
        'UPDATE customer_rewards SET is_redeemed = true, redeemed_at = NOW() WHERE id = $1',
        [rewardIdNum]
      );

      await client.query('COMMIT');
      res.json({ success: true, message: 'Récompense utilisée' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/loyalty/public/redeem-reward error:', err);
      res.status(500).json({ success: false, error: 'DB_ERROR' });
    } finally {
      client.release();
    }
  });

  app.use(csrfProtection);

  /* ───── Routes ───── */

  // Redirect loyalty card page to the separate qrcode-client app
  app.get('/loyalty/:token', (req, res) => {
    res.redirect(301, `${LOYALTY_APP_URL}/loyalty/${req.params.token}`);
  });

  // Supabase / database health check
  app.get('/supabase-health', async (_req, res) => {
    try {
      if (supabase) {
        const { error } = await supabase.from('categorie').select('idcat').limit(1);
        if (error) return res.status(500).json({ ok: false });
      }
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  // get categories
  app.get('/getdata', async (_req, res) => {
    try {
      const result = await pool.query('SELECT * FROM categorie');
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  // get products
  app.get('/product', async (_req, res) => {
    try {
      const result = await pool.query('SELECT * FROM product WHERE archived = FALSE');
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  // create order
  app.post('/demander', async (req, res) => {
    const numtable = Number(req.body.numtable);

    if (!numtable) {
      return res.status(400).json({ success: false, error: 'INVALID_TABLE' });
    }

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const totale = Number(req.body.totale);

    if (!items.length) {
      return res.status(400).json({ success: false, error: 'EMPTY_CART' });
    }

    if (!Number.isFinite(totale) || totale <= 0) {
      return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8);

    let idrecu;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const priceMap = await loadPrices(client, items);
      const fullTotal = baseTotal(items, priceMap);

      const verifyTable = await client.query(
        'SELECT idrecu FROM recu WHERE id=$1 AND heurf IS NULL',
        [numtable]
      );

      if (verifyTable.rowCount === 0) {
        const recuInsert = await client.query(
          'INSERT INTO recu (id, totale, date, heurd, heurf, type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING idrecu',
          [numtable, fullTotal, dateStr, timeStr, null, 'pending']
        );
        idrecu = recuInsert.rows[0].idrecu;
      } else {
        idrecu = verifyTable.rows[0].idrecu;
        await client.query(
          'UPDATE recu SET totale=totale+$1 , type=$3 WHERE idrecu=$2',
          [fullTotal, idrecu, 'pending']
        );
      }

      for (const item of items) {
        const itemPrix = linePrice(item, priceMap);
        await client.query(
          'INSERT INTO orderr (idrecu, id, idname, optionn, status, type, prix) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [idrecu, numtable, String(item.idname), item.optionn ?? null, 'online', 'Pending', itemPrix]
        );
      }

      await client.query('COMMIT');

      // Cash/order route carries no loyalty token, so it never counts a visit:
      // visits are counted on a loyalty-card payment in /process-card-payment.
      res.json({ success: true, idrecu, total: fullTotal });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'DB_ERROR' });
    } finally {
      client.release();
    }
  });

  app.post('/verify-location', (_req, res) => {
    res.json({ authorized: true });
  });

  // GET active promotion
  app.get('/api/promotions/active', async (_req, res) => {
    try {
      const now = new Date().toISOString();
      const result = await pool.query(`
        SELECT discount_percent, minimum_purchase_amount, start_date, end_date FROM promotion
        WHERE start_date <= $1 AND end_date >= $1
        ORDER BY discount_percent DESC LIMIT 1
      `, [now]);

      if (result.rowCount === 0) {
        return res.json({ active: false });
      }

      const promo = result.rows[0];
      res.json({ active: true, discountPercent: promo.discount_percent, minimumPurchaseAmount: Number(promo.minimum_purchase_amount || 0) });
    } catch (err) {
      console.error('GET /api/promotions/active error:', err);
      res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  });

  // GET promotion banner info
  app.get('/api/promotions/banner', async (_req, res) => {
    try {
      const now = new Date().toISOString();
      const active = await pool.query(`
        SELECT discount_percent, minimum_purchase_amount, end_date FROM promotion
        WHERE start_date <= $1 AND end_date >= $1
        ORDER BY discount_percent DESC LIMIT 1
      `, [now]);

      if (active.rowCount > 0) {
        return res.json({ status: 'active', discountPercent: Number(active.rows[0].discount_percent), minimumPurchaseAmount: Number(active.rows[0].minimum_purchase_amount || 0), endDate: active.rows[0].end_date });
      }

      const soon = await pool.query(`
        SELECT discount_percent, minimum_purchase_amount, start_date FROM promotion
        WHERE start_date > $1
        ORDER BY start_date ASC LIMIT 1
      `, [now]);

      if (soon.rowCount > 0) {
        return res.json({ status: 'soon', discountPercent: Number(soon.rows[0].discount_percent), minimumPurchaseAmount: Number(soon.rows[0].minimum_purchase_amount || 0), startDate: soon.rows[0].start_date });
      }

      res.json({ status: 'none' });
    } catch (err) {
      console.error('GET /api/promotions/banner error:', err);
      res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
  });

  // Verify QR code for card payment
  app.post('/verify-qr', paymentLimiter, async (req, res) => {
    let { qrId, total } = req.body;

    const urlMatch = qrId && typeof qrId === 'string' ? qrId.match(/\/loyalty\/([a-f0-9]{24})/i) : null;
    if (urlMatch) qrId = urlMatch[1];

    if (!qrId || typeof qrId !== 'string' || qrId.length < 24) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
    }

    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum < 0) {
      return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
    }

    let discountPercent = 0;
    try { discountPercent = await promotionPercent(pool, totalNum); }
    catch (err) { console.error('Promotion lookup error:', err); }
    const discountedTotal = Math.round(totalNum * (100 - discountPercent)) / 100;

    try {
      const byToken = await pool.query('SELECT token,points,status, name FROM qr_code WHERE token = $1', [qrId]);
      if (byToken.rowCount === 0) {
        return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
      }

      const customer = byToken.rows[0];
      if (customer.status !== 'active') {
        return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
      }

      if (Number(customer.points) < discountedTotal) {
        return res.json({ success: false, error: 'INSUFFICIENT_POINTS' });
      }

      res.json({
        success: true,
        customer: { id: customer.token, name: customer.name, points: customer.points },
        discount: discountPercent > 0 ? { percent: discountPercent, originalTotal: totalNum, discountedTotal } : undefined,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'DB_ERROR' });
    }
  });
  // Fire-and-forget WhatsApp confirmation for a loyalty points deduction.
  // Mirrors serveur's notifyClient(): INSERTs a pending row into the shared
  // `notifications` table that the whatssup Baileys worker drains over WhatsApp.
  // Never blocks or fails the payment flow; errors are logged only.
  function notifyPointsDeduction(cardId, customerName, deductedPoints, remainingPoints) {
    if (!cardId) return;
    void (async () => {
      try {
        await pool.query(
          `INSERT INTO notifications (qr_code_id, category, ref_id, message, template_name, status)
           VALUES ($1, 'points', $2, $3, 'sellamo_points', 'pending')
           ON CONFLICT (qr_code_id, category, ref_id) DO NOTHING`,
          [
            cardId,
            `deduction-${crypto.randomUUID()}`,
            `Bonjour ${customerName || 'Client'}, ${deductedPoints} points ont été déduits de votre carte fidélité. Il vous reste ${remainingPoints} points.`,
          ],
        );
      } catch (err) {
        console.error('notifyPointsDeduction failed:', (err && err.message) || err);
      }
    })();
  }

  // Process card payment — verify card, then atomically insert order + deduct points
  app.post('/process-card-payment', paymentLimiter, async (req, res) => {
    let { qrId, numtable, items, total, rewardId } = req.body;

    const urlMatch = qrId && typeof qrId === 'string' ? qrId.match(/\/loyalty\/([a-f0-9]{24})/i) : null;
    if (urlMatch) qrId = urlMatch[1];
    if (!qrId || typeof qrId !== 'string' || qrId.length < 24) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
    }

    numtable = Number(numtable);
    if (!numtable) {
      return res.status(400).json({ success: false, error: 'INVALID_TABLE' });
    }

    items = Array.isArray(items) ? items : [];
    if (!items.length && !rewardId) {
      return res.status(400).json({ success: false, error: 'EMPTY_CART' });
    }

    const totalNum = Number(total);
    if (isNaN(totalNum) || !Number.isFinite(totalNum) || totalNum < 0) {
      return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
    }
    if (totalNum === 0 && !rewardId) {
      return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const priceMap = await loadPrices(client, items);
      let effectiveDiscount = 0;
      let discountedTotal = 0;

      const byToken = await client.query('SELECT id, token, points, status, name FROM qr_code WHERE token = $1 FOR UPDATE', [qrId]);
      if (byToken.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
      }

      const customerRow = byToken.rows[0];
      if (customerRow.status !== 'active') {
        await client.query('ROLLBACK');
        return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
      }

      const currentPoints = Number(customerRow.points);
      let rewardApplied = false;
      let freeItemIds = new Set();
      if (rewardId) {
        const rewardResult = await client.query(
          `SELECT cr.id, cr.reward_id, cr.is_redeemed, lr.reward_type, lr.discount_percent, lr.product_id
           FROM customer_rewards cr
           JOIN loyalty_rewards lr ON lr.id = cr.reward_id
           WHERE cr.id = $1 AND cr.qr_code_id = $2 AND cr.is_redeemed = false FOR UPDATE OF cr`,
          [rewardId, customerRow.id]
        );
        if (!rewardResult.rowCount) {
          await client.query('ROLLBACK');
          return res.json({ success: false, error: 'REWARD_UNAVAILABLE' });
        }
        const reward = rewardResult.rows[0];
        if (reward.reward_type === 'discount' && Number(reward.discount_percent) > 0) {
          // An earned discount replaces the promotion; discounts never stack.
          effectiveDiscount = Number(reward.discount_percent);
        } else if (reward.reward_type === 'free_item' && reward.product_id) {
          const freeId = String(reward.product_id);
          if (items.some(item => String(item.idname) === freeId)) freeItemIds.add(freeId);
        }
        await client.query(
          'UPDATE customer_rewards SET is_redeemed = true, redeemed_at = NOW() WHERE id = $1',
          [rewardId]
        );
        rewardApplied = true;
      }

      const paidBase = baseTotal(items, priceMap, 0, freeItemIds);
      if (!effectiveDiscount) effectiveDiscount = await promotionPercent(client, paidBase);
      discountedTotal = baseTotal(items, priceMap, effectiveDiscount, freeItemIds);
      if (currentPoints < discountedTotal) {
        await client.query('ROLLBACK');
        return res.json({ success: false, error: 'INSUFFICIENT_POINTS' });
      }

      // Preserve visit/reward tracking before this order creates an open receipt.
      await client.query('SAVEPOINT payment_visit');
      try {
        await processVisitForCardPayment(client, customerRow.id, customerRow.name);
        await client.query('RELEASE SAVEPOINT payment_visit');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT payment_visit');
        console.warn('Visit counting failed (non-fatal):', err.message);
      }

      let idrecu;
      const verifyTable = await client.query(
        'SELECT idrecu FROM recu WHERE id=$1 AND heurf IS NULL',
        [numtable]
      );

      if (verifyTable.rowCount === 0) {
        const recuInsert = await client.query(
          'INSERT INTO recu (id, totale, date, heurd, heurf, type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING idrecu',
          [numtable, discountedTotal, dateStr, timeStr, null, 'pending']
        );
        idrecu = recuInsert.rows[0].idrecu;
      } else {
        idrecu = verifyTable.rows[0].idrecu;
        await client.query(
          'UPDATE recu SET totale=totale+$1, type=$3 WHERE idrecu=$2',
          [discountedTotal, idrecu, 'pending']
        );
      }

      for (const item of items) {
        const itemPrix = linePrice(item, priceMap, effectiveDiscount, freeItemIds);
        await client.query(
          "INSERT INTO orderr (idrecu, id, idname, optionn, status, type, prix, paid, nom_ut) VALUES ($1,$2,$3,$4,$5,$6,$7,'oui',$8)",
          [idrecu, numtable, String(item.idname), item.optionn ?? null, 'online', 'Pending', itemPrix, customerRow.name || null]
        );
      }

      await client.query('UPDATE qr_code SET points = points - $1, updated_at = NOW() WHERE token = $2', [discountedTotal, customerRow.token]);

      await client.query(`
        UPDATE recu SET
          payment_method = 'loyalty_card',
          discount_percent = $1
        WHERE idrecu = $2
      `, [effectiveDiscount > 0 ? effectiveDiscount : null, idrecu]);

      await client.query('COMMIT');

      const remainingPoints = Math.round((currentPoints - discountedTotal) * 100) / 100;
      notifyPointsDeduction(customerRow.id, customerRow.name, discountedTotal, remainingPoints);

      res.json({ success: true, idrecu, rewardApplied: rewardApplied || false, total: discountedTotal, remainingPoints });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'DB_ERROR' });
    } finally {
      client.release();
    }
  });

  // Cash payment
  app.post('/process-cash-payment', async (req, res) => {
    const { idrecu, total } = req.body;

    const idrecuNum = Number(idrecu);
    if (!idrecu || isNaN(idrecuNum) || idrecuNum <= 0) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS' });
    }

    const totalNum = Number(total);
    if (isNaN(totalNum) || totalNum <= 0 || !Number.isFinite(totalNum)) {
      return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
    }

    try {
      // Read persisted line prices: a forged discounted browser total cannot lower cash.
      const result = await pool.query(
        `UPDATE recu SET payment_method = 'cash', discount_percent = NULL,
          totale = (SELECT COALESCE(SUM(prix), 0) FROM orderr WHERE idrecu = $1)
         WHERE idrecu = $1 AND EXISTS (SELECT 1 FROM orderr WHERE idrecu = $1)
         RETURNING totale`, [idrecuNum]
      );
      if (!result.rowCount) return res.status(404).json({ success: false, error: 'RECEIPT_NOT_FOUND' });
      res.json({ success: true, total: Number(result.rows[0].totale) });
    } catch (err) {
      console.error('Cash payment update error:', err);
      res.status(500).json({ success: false, error: 'DB_ERROR' });
    }
  });

  return app;
}
