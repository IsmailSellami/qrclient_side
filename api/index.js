import { createClient } from '@supabase/supabase-js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';

const { Pool } = pg;

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
  origin: true,
  credentials: false,
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

app.use(csrfProtection);

/* ───── Supabase client (health check) ───── */

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/* ───── Database pool ───── */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

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
    const result = await pool.query('SELECT * FROM product');
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

  if (!totale) {
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
    const priceResult = await pool.query(
      'SELECT idname, price FROM product WHERE idname = ANY($1)',
      [itemNames]
    );
    for (const row of priceResult.rows) {
      priceMap[row.idname] = Number(row.price || 0);
    }
    const nowIso = new Date().toISOString();
    const promoResult = await pool.query(`
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

  const client = await pool.connect();
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
      await client.query(
        'UPDATE recu SET totale=totale+$1 , type=$3 WHERE idrecu=$2',
        [Number(totale), idrecu, 'pending']
      );
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

    await client.query('COMMIT');
    res.json({ success: true, idrecu });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false });
  } finally {
    client.release();
  }
});

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post('/verify-location', (req, res) => {
  const lat = parseFloat(req.body.latitude);
  const lng = parseFloat(req.body.longitude);

  if (isNaN(lat) || isNaN(lng) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.json({ authorized: false });
  }

  const CAFE_LAT = 34.77015823848953;
  const CAFE_LNG = 10.72152628978018;
  const distance = getDistance(lat, lng, CAFE_LAT, CAFE_LNG);

  res.json({ authorized: distance <= 100 });
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

  const totalNum = Number(total.toFixed(2));

  let discountedTotal = totalNum;
  let discountPercent = 0;
  let minimumPurchaseAmount = 0;
  try {
    const now = new Date().toISOString();
    const promoResult = await pool.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC LIMIT 1
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

// Process card payment
app.post('/process-card-payment', paymentLimiter, async (req, res) => {
  let { qrId, idrecu, total } = req.body;

  const urlMatch = qrId && typeof qrId === 'string' ? qrId.match(/\/loyalty\/([a-f0-9]{24})/i) : null;
  if (urlMatch) qrId = urlMatch[1];

  if (!qrId || typeof qrId !== 'string' || qrId.length < 24) {
    return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
  }

  const idrecuNum = Number(idrecu);
  if (!idrecu || isNaN(idrecuNum) || idrecuNum <= 0) {
    return res.status(400).json({ success: false, error: 'MISSING_PARAMS' });
  }

  const totalNum = Number(total);
  if (isNaN(totalNum) || totalNum <= 0 || !Number.isFinite(totalNum)) {
    return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
  }

  let discountedTotal = Number(totalNum);
  let discountPercent = 0;
  let minimumPurchaseAmount = 0;
  try {
    const now = new Date().toISOString();
    const promoResult = await pool.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC LIMIT 1
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const byToken = await client.query('SELECT token,points,status FROM qr_code WHERE token = $1 FOR UPDATE', [qrId]);
    if (byToken.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
    }

    const customerRow = byToken.rows[0];
    const currentPoints = Number(customerRow.points);
    if (currentPoints < discountedTotal) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'INSUFFICIENT_POINTS' });
    }

    discountedTotal = Number(discountedTotal.toFixed(3));
    await client.query('UPDATE qr_code SET points = points - $1, updated_at = NOW() WHERE token = $2', [discountedTotal, customerRow.token]);

    await client.query("UPDATE orderr SET paid = 'oui' WHERE idrecu = $1", [idrecuNum]);

    await client.query(`
      UPDATE recu SET
        totale = $1,
        payment_method = 'loyalty_card',
        discount_percent = $2
      WHERE idrecu = $3
    `, [discountedTotal, discountPercent > 0 ? discountPercent : null, idrecuNum]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'DB_ERROR' });
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

  let discountedTotal = totalNum;
  let discountPercent = 0;
  let minimumPurchaseAmount = 0;
  try {
    const now = new Date().toISOString();
    const promoResult = await pool.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY discount_percent DESC LIMIT 1
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
    await pool.query(`
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

// Loyalty token lookup (public)
app.get('/api/loyalty/token/:token', async (req, res) => {
  try {
    const raw = req.params.token;
    if (!raw || raw.length < 24) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }

    const result = await pool.query('SELECT * FROM qr_code WHERE token = $1', [raw]);
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
      points: card.points || 0,
      status: card.status || 'active',
      assignedAt: card.assigned_at,
    });
  } catch (err) {
    console.error('GET /api/loyalty/token/:token error:', err);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

export default app;
