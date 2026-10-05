import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import dns from 'dns';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import crypto from 'crypto';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dns.setDefaultResultOrder('verbatim');

const app = express();
const port = process.env.PORT || 3991;

/* ───── Environment ───── */

const LOYALTY_APP_URL = process.env.LOYALTY_APP_URL || 'https://qrcode-client-alpha.vercel.app';

/* ───── Security helpers ───── */

function isSameOrigin(req) {
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];
  const host = req.headers['host'];
  if (!host) return false;
  if (origin && (origin === `http://${host}` || origin === `https://${host}` || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`)) return true;
  if (referer) {
    try {
      const u = new URL(referer);
      if (u.host === host || u.host === `localhost:${port}` || u.host === `127.0.0.1:${port}`) return true;
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

const allowedOrigins = [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://192.168.') || origin.startsWith('http://10.')) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
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
      upgradeInsecureRequests: [],
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

// static files
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

/* ───── Public Loyalty Endpoints (before CSRF) ───── */

// loyalty token lookup (public)
app.get('/api/loyalty/token/:token', async (req, res) => {
  try {
    const raw = req.params.token;
    if (!raw || raw.length < 24) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }

    const result = await client.query(
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
      client.query('SELECT id, amount, base_points AS "basePoints", bonus_points AS "bonusPoints", total_points AS "totalPoints", label, is_promotional AS "isPromotional", starts_at AS "startsAt", ends_at AS "endsAt" FROM loyalty_recharge_packages WHERE is_active = true ORDER BY amount ASC'),
      client.query('SELECT id, name, description, required_points AS "requiredPoints", reward_type AS "rewardType", discount_percent AS "discountPercent", product_id AS "productId" FROM loyalty_rewards WHERE is_active = true AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at >= NOW()) ORDER BY required_points ASC'),
      client.query('SELECT id, name, description, challenge_type AS "challengeType", target, bonus_points AS "bonusPoints", start_date AS "startDate", end_date AS "endDate" FROM loyalty_challenges WHERE is_active = true AND start_date <= NOW() AND end_date >= NOW() ORDER BY end_date ASC'),
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

    const cardResult = await client.query(
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
    const rewardsResult = await client.query(
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
    const challengesResult = await client.query(
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
    const monthlyResult = await client.query(
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

/* ───── Customer visits (recomponce.md §4, §5) ───── */

// Same accounting as the Express implementation in serveur/src/services/
// loyalty.service.ts, expressed in raw SQL. Kept in sync on purpose: the public
// client and the manager back office must agree on when a visit starts, or the
// counter drifts between the two.
async function openVisitForToken(token, numtable) {
  const cardResult = await client.query(
    'SELECT id, status, visit_count FROM qr_code WHERE token = $1',
    [token]
  );
  if (cardResult.rowCount === 0) return { error: 'NOT_FOUND' };
  if (cardResult.rows[0].status !== 'active') return { error: 'INACTIVE_CARD' };
  const cardId = cardResult.rows[0].id;

  const recuResult = await client.query(
    'SELECT idrecu FROM recu WHERE id = $1 AND heurf IS NULL ORDER BY idrecu DESC LIMIT 1',
    [numtable]
  );
  if (recuResult.rowCount === 0) return { error: 'TABLE_NOT_OPEN' };
  const recuId = recuResult.rows[0].idrecu;

  // A forgotten "Sortire" must never freeze the customer forever: close visits
  // older than the stale window before deciding if this is a new visit.
  const staleCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const stale = await client.query(
    `SELECT DISTINCT recu_id FROM customer_visits
     WHERE qr_code_id = $1 AND status = 'open' AND started_at < $2 AND recu_id IS NOT NULL`,
    [cardId, staleCutoff]
  );
  for (const row of stale.rows) {
    const claimed = await client.query(
      `UPDATE customer_visits SET status = 'completed', counted = true, ended_at = NOW()
       WHERE qr_code_id = $1 AND recu_id = $2 AND status = 'open'
       RETURNING id`,
      [cardId, row.recu_id]
    );
    if (claimed.rowCount > 0) {
      await client.query('UPDATE qr_code SET visit_count = visit_count + 1 WHERE id = $1', [cardId]);
    }
  }

  // Get-or-create for THIS receipt. Re-scanning the same card at the same table
  // returns the same row (created:false) so one sitting counts once; a different
  // receipt is a new visit.
  const existing = await client.query(
    `SELECT id, numtable FROM customer_visits
     WHERE qr_code_id = $1 AND recu_id = $2 AND status = 'open'`,
    [cardId, recuId]
  );
  let visit;
  if (existing.rowCount > 0) {
    visit = { id: Number(existing.rows[0].id), numtable: existing.rows[0].numtable, created: false };
  } else {
    const created = await client.query(
      `INSERT INTO customer_visits (qr_code_id, recu_id, numtable, status, counted, started_at)
       VALUES ($1, $2, $3, 'open', false, NOW())
       ON CONFLICT DO NOTHING
       RETURNING id, numtable`,
      [cardId, recuId, numtable]
    );
    if (created.rowCount > 0) {
      visit = { id: Number(created.rows[0].id), numtable: created.rows[0].numtable, created: true };
    } else {
      // Lost a race with a concurrent scan — reuse the winner's row.
      const again = await client.query(
        `SELECT id, numtable FROM customer_visits
         WHERE qr_code_id = $1 AND recu_id = $2 AND status = 'open'`,
        [cardId, recuId]
      );
      visit = { id: Number(again.rows[0].id), numtable: again.rows[0].numtable, created: false };
    }
  }

  const after = await client.query('SELECT visit_count FROM qr_code WHERE id = $1', [cardId]);
  return { cardId, visitCount: Number(after.rows[0]?.visit_count || 0), visit };
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
async function queueVisitNotification(cardId, category, refId, message, templateName) {
  await client.query(
    `INSERT INTO notifications (qr_code_id, category, ref_id, message, template_name, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (qr_code_id, category, ref_id) DO NOTHING`,
    [cardId, category, refId, message, templateName],
  );
}

/**
 * Record that an order happened during a visit and, when this order is the one
 * that completes a `required_visits` threshold, count the visit straight away.
 *
 * recomponce.md §6: an order is what makes a visit valid, so the order is also the
 * earliest moment the customer is certainly there. Ordinary visits stay `open` and
 * are still counted when the waiter frees the table with "Sortire"; only the visit
 * that reaches a threshold is claimed here, so the reward is unlocked and notified
 * without waiting for the customer to leave.
 *
 * Idempotent and race-safe, mirroring closeVisitsForRecu()/notifyVisitUnlocks():
 *  - `order_count` is a plain increment on the still-open row;
 *  - the claim is one conditional `UPDATE ... WHERE status = 'open'`, so only the
 *    caller that flips the row performs the `visit_count` increment — a later
 *    "Sortire" (or a duplicate payment) matches nothing and cannot double count;
 *  - reward claims go through uq_customer_reward_unredeemed, so a reward is
 *    granted once and stays the customer's permanently (R1/R2).
 *
 * `cardId` is null on the cash route (/demander), where the card was associated by
 * the waiter instead of scanned; the visit row itself still carries the card.
 *
 * Never throws: a progress hiccup must never void a valid order.
 */
async function recordVisitOrderForRecu(recuId, cardId) {
  const openVisits = cardId
    ? await client.query(
        `SELECT id, qr_code_id FROM customer_visits
          WHERE qr_code_id = $1 AND recu_id = $2 AND status = 'open'`,
        [cardId, recuId])
    : await client.query(
        `SELECT id, qr_code_id FROM customer_visits
          WHERE recu_id = $1 AND status = 'open'`,
        [recuId]);

  let visitCount;
  for (const visit of openVisits.rows) {
    const targetCard = Number(visit.qr_code_id);

    // An order happened, so the visit is now order-backed.
    const ordered = await client.query(
      `UPDATE customer_visits SET order_count = order_count + 1
        WHERE id = $1 AND status = 'open' RETURNING id`,
      [visit.id]);
    if (ordered.rowCount === 0) continue; // closed in the meantime

    const card = await client.query(
      'SELECT id, name, phone, visit_count FROM qr_code WHERE id = $1',
      [targetCard]);
    if (card.rowCount === 0) continue;
    visitCount = Number(card.rows[0].visit_count || 0);

    // Would counting this visit right now unlock a visit reward? The window
    // filter mirrors unlockRewardsForVisit(): ends_at gates UNLOCK, and a reward
    // earned inside the window is never invalidated later (R1).
    const reaching = await client.query(
      `SELECT id, name FROM loyalty_rewards
        WHERE is_active = true AND trigger_type = 'visits' AND required_visits <= $1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
        ORDER BY required_visits ASC`,
      [visitCount + 1]);
    if (reaching.rowCount === 0) continue; // not the completing visit → "Sortire" counts it

    // The atomic claim: only the caller that flips exactly one open row counts.
    const claimed = await client.query(
      `UPDATE customer_visits SET status = 'completed', counted = true, ended_at = NOW()
        WHERE id = $1 AND status = 'open' RETURNING id`,
      [visit.id]);
    if (claimed.rowCount === 0) continue;

    const bumped = await client.query(
      'UPDATE qr_code SET visit_count = visit_count + 1 WHERE id = $1 RETURNING visit_count',
      [targetCard]);
    visitCount = Number(bumped.rows[0].visit_count);

    if (!visitPhoneEligible(card.rows[0].phone)) continue;
    const who = card.rows[0].name || 'Client';

    for (const reward of reaching.rows) {
      const claim = await client.query(
        `INSERT INTO customer_rewards (qr_code_id, reward_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING id`,
        [targetCard, reward.id]);
      if (claim.rowCount === 0) continue; // already owned → do not announce twice
      await queueVisitNotification(
        targetCard, 'reward', `claim-${claim.rows[0].id}`,
        `Bonjour ${who}, vous avez débloqué la récompense « ${reward.name} » 🎉🎉`,
        'sellamo_reward');
    }

    const next = await client.query(
      `SELECT name, required_visits FROM loyalty_rewards
        WHERE is_active = true AND trigger_type = 'visits' AND required_visits > $1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
        ORDER BY required_visits ASC LIMIT 1`,
      [visitCount]);

    let message = `Bonjour ${who}, votre ${visitCount}e visite au café est enregistrée !`;
    if (next.rowCount > 0) {
      const remaining = Number(next.rows[0].required_visits) - visitCount;
      if (remaining > 0) {
        message += ` Il vous reste ${remaining} visite${remaining > 1 ? 's' : ''} pour : ${next.rows[0].name}.`;
      }
    }
    await queueVisitNotification(
      targetCard, 'visit', `visit-${visit.id}`, message, 'sellamo_visit');
  }

  return visitCount;
}

/**
 * Public: the customer scans their card at a table. This is the primary way a
 * visit begins. The visit is COUNTED when the table is freed with "Sortire"
 * (or swept as stale after 12h), not here — a scan alone must never award.
 */
app.post('/api/loyalty/visit/start', async (req, res) => {
  const { token, numtable } = req.body || {};
  if (!token || typeof token !== 'string' || token.length < 24) {
    return res.status(400).json({ success: false, error: 'TOKEN_REQUIRED' });
  }
  const table = Number(numtable);
  if (!Number.isInteger(table) || table < 1) {
    return res.status(400).json({ success: false, error: 'TABLE_REQUIRED' });
  }
  try {
    const result = await openVisitForToken(token, table);
    if (result.error === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /api/loyalty/visit/start error:', err);
    res.status(500).json({ success: false, error: 'DB_ERROR' });
  }
});

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

    const cardResult = await client.query('SELECT id, status FROM qr_code WHERE token = $1', [token]);
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
  }
});

app.use(csrfProtection);

/* ───── Supabase client (health check) ───── */

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY in environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/* ───── Database (Supabase PostgreSQL) ───── */

if (!process.env.DATABASE_URL) {
  console.error('❌ Missing DATABASE_URL in environment variables.');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ───── Start server ───── */

async function startServer() {
  try {
    try {
      const dbUrl = new URL(process.env.DATABASE_URL);
      const host = dbUrl.hostname;
      await dns.promises.lookup(host, { all: true });
    } catch (e) {
      console.error('❌ Failed to resolve DATABASE_URL host');
    }

    await client.connect();
    console.log('✅ Database connected (Supabase)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS qr_code (
        id TEXT PRIMARY KEY,
        points NUMERIC(10,3) NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT ''
      )
    `);
    await client.query(`ALTER TABLE orderr ADD COLUMN IF NOT EXISTS paid TEXT DEFAULT 'non'`);
    await client.query(`ALTER TABLE orderr ADD COLUMN IF NOT EXISTS prix NUMERIC(10,2)`);
    await client.query(`ALTER TABLE promotion ADD COLUMN IF NOT EXISTS minimum_purchase_amount NUMERIC(10,2) DEFAULT 0`);
    await client.query(`ALTER TABLE promotion DROP COLUMN IF EXISTS status`);
    console.log('✅ qr_code table ready');
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
  });
}

startServer();

/* ───── Routes ───── */

// home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// loyalty page — redirect to the deployed qrcode-client app
app.get('/loyalty/:token', (req, res) => {
  res.redirect(301, `${LOYALTY_APP_URL}/loyalty/${req.params.token}`);
});

app.get('/supabase-health', async (req, res) => {
  try {
    const { error } = await supabase.from('categorie').select('idcat').limit(1);
    if (error) return res.status(500).json({ ok: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// get categories
app.get('/getdata', async (req, res) => {
  try {
    const result = await client.query('SELECT * FROM categorie');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

// get products
app.get('/product', async (req, res) => {
  try {
    const result = await client.query('SELECT * FROM product WHERE archived = FALSE');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

// create order
app.post('/demander', async (req, res) => {
  const payload = req.body || {};
  const numtable = Number(req.body.numtable);

  if (!numtable) {
    return res.status(400).json({ success: false, error: "INVALID_TABLE" });
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const totale = Number(payload.totale);

  if (!items.length) {
    console.log('⚠️ Empty cart received');
    return res.status(400).json({ success: false, error: 'EMPTY_CART' });
  }

  if (!totale) {
    console.log('⚠️ Invalid total received');
    return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
  }
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);

  let idrecu;

  // Look up product prices and check for active promotion
  const itemNames = [...new Set(items.map(i => String(i.idname)))];
  let priceMap = {};
  let discountPercent = 0;
  try {
    const priceResult = await client.query(
      'SELECT idname, price FROM product WHERE idname = ANY($1)',
      [itemNames]
    );
    for (const row of priceResult.rows) {
      priceMap[row.idname] = Number(row.price || 0);
    }
    const nowIso = new Date().toISOString();
    const promoResult = await client.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC LIMIT 1
    `, [nowIso]);
    if (promoResult.rowCount > 0) {
      discountPercent = Number(promoResult.rows[0].discount_percent);
      const minimumPurchaseAmount = Number(promoResult.rows[0].minimum_purchase_amount || 0);
      const baseTotale = items.reduce((sum, item) => sum + (priceMap[String(item.idname)] || 0), 0);
      if (baseTotale < minimumPurchaseAmount) {
        discountPercent = 0;
      }
    }
  } catch (e) {
    console.error('Price lookup error (non-fatal):', e.message);
  }

  try {
    await client.query('BEGIN');

    const verifyTable = await client.query(
      'SELECT idrecu FROM recu WHERE id=$1 AND heurf IS NULL',
      [numtable]
    );

    if (verifyTable.rowCount === 0) {
      const recuInsert = await client.query(
        'INSERT INTO recu (id, totale, date, heurd, heurf, type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING idrecu',
        [numtable, totale, dateStr, timeStr, null, 'pending']
      );

      idrecu = recuInsert.rows[0].idrecu;
    } else {
      idrecu = verifyTable.rows[0].idrecu;
      const updateResult = await client.query(
        'UPDATE recu SET totale=totale+$1 , type=$3 WHERE idrecu=$2 RETURNING idrecu, totale',
        [Number(totale), idrecu, 'pending']
      );
      console.log('ℹ️ Existing open recu found for table', numtable, 'with idrecu:', idrecu);
      if (updateResult.rowCount > 0) {
        console.log('✅ recu updated');
      } else {
        console.log('⚠️ No recu was updated. Something went wrong.');
      }
    }
    for (const item of items) {
      const basePrice = priceMap[String(item.idname)] || 0;
      const itemPrix = discountPercent > 0
        ? Math.round(basePrice * (100 - discountPercent) / 100 * 1000) / 1000
        : basePrice;
      await client.query(
        'INSERT INTO orderr (idrecu, id, idname, optionn, status, type, prix) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [idrecu, numtable, String(item.idname), item.optionn ?? null, 'online', 'Pending', itemPrix]
      );
    }
    console.log('ℹ️ Current idrecu:', idrecu);
    await client.query('COMMIT');

    // Cash order: no loyalty token on this route, but the waiter may still have
    // associated a card to this receipt. The order makes that visit valid and, if
    // it completes a threshold, counts it now. cardId is null so every open visit
    // on this receipt is considered. Non-fatal: never void a valid order.
    try {
      await recordVisitOrderForRecu(idrecu, null);
    } catch (visitOrderErr) {
      console.warn('Visit order not recorded (non-fatal):', visitOrderErr.message);
    }

    res.json({ success: true, idrecu });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false });
  }
});

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // mètres

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post("/verify-location", (_req, res) => {
  console.log('Verifying location...');
  return res.json({ authorized: true });
});

// GET active promotion (for discounts)
app.get('/api/promotions/active', async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await client.query(`
      SELECT discount_percent, minimum_purchase_amount, start_date, end_date FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC
      LIMIT 1
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

// GET promotion banner info (active + upcoming)
app.get('/api/promotions/banner', async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const active = await client.query(`
      SELECT discount_percent, minimum_purchase_amount, end_date FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC LIMIT 1
    `, [now]);

    if (active.rowCount > 0) {
      return res.json({ status: 'active', discountPercent: Number(active.rows[0].discount_percent), minimumPurchaseAmount: Number(active.rows[0].minimum_purchase_amount || 0), endDate: active.rows[0].end_date });
    }

    const soon = await client.query(`
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
  const totalNum = Number(total.toFixed(2));

  // Check for active promotion
  let discountedTotal = totalNum;
  let discountPercent = 0;
  let minimumPurchaseAmount = 0;
  try {
    const now = new Date().toISOString();
    const promoResult = await client.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1
        AND end_date >= $1
      ORDER BY discount_percent DESC
      LIMIT 1
    `, [now]);
    if (promoResult.rowCount > 0) {
      discountPercent = Number(promoResult.rows[0].discount_percent);
      minimumPurchaseAmount = Number(promoResult.rows[0].minimum_purchase_amount || 0);
      if (totalNum >= minimumPurchaseAmount) {
        discountedTotal = Math.round(totalNum * (100 - discountPercent) / 100 * 1000) / 1000;
      } else {
        discountPercent = 0;
      }
    }
  } catch (err) {
    console.error('Promotion lookup error (non-fatal):', err);
  }

  try {
    const byToken = await client.query('SELECT token,points,status, name FROM qr_code WHERE token = $1', [qrId]);
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

    return res.json({
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
      await client.query(
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

  const itemNames = [...new Set(items.map(i => String(i.idname)))];
  let priceMap = {};
  let discountPercent = 0;
  try {
    const priceResult = await client.query(
      'SELECT idname, price FROM product WHERE idname = ANY($1)',
      [itemNames]
    );
    for (const row of priceResult.rows) {
      priceMap[row.idname] = Number(row.price || 0);
    }
    const nowIso = new Date().toISOString();
    const promoResult = await client.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC LIMIT 1
    `, [nowIso]);
    if (promoResult.rowCount > 0) {
      discountPercent = Number(promoResult.rows[0].discount_percent);
      const minimumPurchaseAmount = Number(promoResult.rows[0].minimum_purchase_amount || 0);
      const baseTotale = items.reduce((sum, item) => sum + (priceMap[String(item.idname)] || 0), 0);
      if (baseTotale < minimumPurchaseAmount) {
        discountPercent = 0;
      }
    }
  } catch (e) {
    console.error('Price lookup error (non-fatal):', e.message);
  }

  let discountedTotal = totalNum;
  let effectiveDiscount = discountPercent;
  if (discountPercent > 0) {
    discountedTotal = Math.round(totalNum * (100 - discountPercent) / 100 * 1000) / 1000;
  }

  try {
    await client.query('BEGIN');

    const byToken = await client.query('SELECT token,points,status,name,id FROM qr_code WHERE token = $1 FOR UPDATE', [qrId]);
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
    if (currentPoints < discountedTotal) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'INSUFFICIENT_POINTS' });
    }

    let rewardDiscount = 0;
    let rewardApplied = false;
    let freeItemIds = new Set();
    if (rewardId) {
      try {
        const cardResult = await client.query('SELECT id FROM qr_code WHERE token = $1', [qrId]);
        if (cardResult.rowCount > 0) {
          const cardId = cardResult.rows[0].id;
          const rewardResult = await client.query(
            `SELECT cr.id, cr.reward_id, cr.is_redeemed, lr.reward_type, lr.discount_percent, lr.product_id
             FROM customer_rewards cr
             JOIN loyalty_rewards lr ON lr.id = cr.reward_id
             WHERE cr.id = $1 AND cr.qr_code_id = $2 AND cr.is_redeemed = false`,
            [rewardId, cardId]
          );
          if (rewardResult.rowCount > 0) {
            const reward = rewardResult.rows[0];
            if (reward.reward_type === 'discount' && Number(reward.discount_percent) > 0) {
              rewardDiscount = Number(reward.discount_percent);
              // A discount reward REPLACES any active promotion (never stacked):
              // apply the reward to the base order total.
              effectiveDiscount = rewardDiscount;
              discountedTotal = Math.round(totalNum * (100 - rewardDiscount) / 100 * 1000) / 1000;
            } else if (reward.reward_type === 'free_item' && reward.product_id) {
              // Free-product reward: the free product is a real order line but at 0.00 DT.
              // The client's paid total (frontend) already excludes this product's price,
              // so we only flag it here so the matching orderr line is written with prix=0.
              const freeId = String(reward.product_id);
              if (items.some(i => String(i.idname) === freeId)) {
                freeItemIds = new Set([freeId]);
              }
            }
            await client.query(
              'UPDATE customer_rewards SET is_redeemed = true, redeemed_at = NOW() WHERE id = $1',
              [rewardId]
            );
            rewardApplied = true;
          } else {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'REWARD_UNAVAILABLE' });
          }
        }
      } catch (rewardErr) {
        console.error('Reward lookup error (non-fatal):', rewardErr.message);
      }
    }

    let idrecu;
    const verifyTable = await client.query(
      'SELECT idrecu FROM recu WHERE id=$1 AND heurf IS NULL',
      [numtable]
    );

    if (verifyTable.rowCount === 0) {
      const recuInsert = await client.query(
        'INSERT INTO recu (id, totale, date, heurd, heurf, type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING idrecu',
        [numtable, totalNum, dateStr, timeStr, null, 'pending']
      );
      idrecu = recuInsert.rows[0].idrecu;
    } else {
      idrecu = verifyTable.rows[0].idrecu;
      await client.query(
        'UPDATE recu SET totale=totale+$1, type=$3 WHERE idrecu=$2',
        [Number(totalNum), idrecu, 'pending']
      );
    }

    for (const item of items) {
      const basePrice = priceMap[String(item.idname)] || 0;
      let itemPrix = effectiveDiscount > 0
        ? Math.round(basePrice * (100 - effectiveDiscount) / 100 * 1000) / 1000
        : basePrice;
      if (freeItemIds.has(String(item.idname))) {
        itemPrix = 0;
      }
      await client.query(
        "INSERT INTO orderr (idrecu, id, idname, optionn, status, type, prix, paid, nom_ut) VALUES ($1,$2,$3,$4,$5,$6,$7,'oui',$8)",
        [idrecu, numtable, String(item.idname), item.optionn ?? null, 'online', 'Pending', itemPrix, customerRow.name || null]
      );
    }

    discountedTotal = Number(discountedTotal.toFixed(2));
    await client.query('UPDATE qr_code SET points = points - $1, updated_at = NOW() WHERE token = $2', [discountedTotal, customerRow.token]);

    await client.query(`
      UPDATE recu SET
        totale = $1,
        payment_method = 'loyalty_card',
        discount_percent = $2
      WHERE idrecu = $3
    `, [discountedTotal, effectiveDiscount > 0 ? effectiveDiscount : null, idrecu]);

    await client.query('COMMIT');

    // recomponce.md §4 + §12: the payment is the moment the card is definitively
    // bound to this table, so the visit is opened here — the customer never has to
    // ask the waiter to associate their card. Must run AFTER COMMIT so the receipt
    // written above is visible. Idempotent (uq_customer_visit_open), and deliberately
    // non-fatal — a visit hiccup must never void a valid payment.
    let visitCount;
    try {
      const visitResult = await openVisitForToken(qrId, numtable);
      if (visitResult.error) console.warn('Visit not opened:', visitResult.error);
      else visitCount = visitResult.visitCount;
    } catch (visitErr) {
      console.warn('Visit not opened (non-fatal):', visitErr.message);
    }

    // The order is what makes the visit valid, so record it against the open
    // visit — and if this order is the one that completes a `required_visits`
    // threshold, count it here instead of waiting for "Sortire" (recomponce.md §6).
    try {
      const counted = await recordVisitOrderForRecu(idrecu, customerRow.id);
      if (counted !== undefined) visitCount = counted;
    } catch (visitOrderErr) {
      console.warn('Visit order not recorded (non-fatal):', visitOrderErr.message);
    }

    const remainingPoints = Math.round((currentPoints - discountedTotal) * 100) / 100;
    notifyPointsDeduction(customerRow.id, customerRow.name, discountedTotal, remainingPoints);

    res.json({ success: true, idrecu, rewardApplied: rewardApplied || false, visitCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'DB_ERROR' });
  }
});

// Cash payment endpoint (tracks cash payments for reporting)
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

  let discountedTotal = totalNum;
  let discountPercent = 0;
  let minimumPurchaseAmount = 0;
  try {
    const now = new Date().toISOString();
    const promoResult = await client.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1
        AND end_date >= $1
      ORDER BY discount_percent DESC
      LIMIT 1
    `, [now]);
    if (promoResult.rowCount > 0) {
      discountPercent = Number(promoResult.rows[0].discount_percent);
      minimumPurchaseAmount = Number(promoResult.rows[0].minimum_purchase_amount || 0);
      if (totalNum >= minimumPurchaseAmount) {
        discountedTotal = Math.round(totalNum * (100 - discountPercent) / 100 * 1000) / 1000;
      } else {
        discountPercent = 0;
      }
    }
  } catch (err) {
    console.error('Promotion lookup error (non-fatal):', err);
  }

  try {
    await client.query(`
      UPDATE recu SET
        payment_method = 'cash',
        discount_percent = $1,
        totale = $2
      WHERE idrecu = $3
    `, [discountPercent > 0 ? discountPercent : null, discountedTotal, idrecuNum]);

    res.json({ success: true });
  } catch (err) {
    console.error('Cash payment update error:', err);
    res.status(500).json({ success: false, error: 'DB_ERROR' });
  }
});
