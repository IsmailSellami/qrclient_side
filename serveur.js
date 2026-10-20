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

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dns.setDefaultResultOrder('verbatim');

const app = express();
const port = process.env.PORT || 3000;

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

/* ================= MIDDLEWARES ================= */

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
      imgSrc: ["'self'", "data:"],
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

const strictLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de requêtes' },
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.use(csrfProtection);

// static files
app.use(express.static(path.join(__dirname, 'file')));
app.use(express.static(path.join(__dirname, '..', 'qrcode-client')));

/* ================= SUPABASE CLIENT ================= */

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY in environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/* ================= DATABASE (Supabase PostgreSQL) ================= */

if (!process.env.DATABASE_URL) {
  console.error('❌ Missing DATABASE_URL in environment variables.');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

/* ================= START SERVER ================= */

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

/* ================= ROUTES ================= */

// home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'file', 'html', 'index.html'));
});

// loyalty page — serves qrcode-client/index.html
app.get('/loyalty/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'qrcode-client', 'index.html'));
});

// loyalty token lookup (public)
app.get('/api/loyalty/token/:token', async (req, res) => {
  try {
    const raw = req.params.token;
    if (!raw || raw.length < 24) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }

    const result = await client.query('SELECT * FROM qr_code WHERE token = $1', [raw]);
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

app.get('/supabase-health', async (req, res) => {
  try {
    const { error } = await supabase.from('categorie').select('id').limit(1);
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
    const result = await client.query('SELECT * FROM product');
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
  
  if (!items.length){
    return res.status(400).json({ success: false, error: 'EMPTY_CART' });
    console.log('⚠️ Empty cart received');
    }
 
  if (!totale){
    console.log('⚠️ Invalid total received');
    return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
  }
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);

  let idrecu;

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

    }  else {
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
      await client.query(
        'INSERT INTO orderr (idrecu, id, idname, optionn,status,type) VALUES ($1,$2,$3,$4,$5,$6 )',
        [idrecu, numtable, String(item.idname), item.optionn ?? null, 'online', 'Pending']
      );
    }
console.log('ℹ️ Current idrecu:', idrecu);
    await client.query('COMMIT');

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

app.post("/verify-location", (req, res) => {
  const lat = parseFloat(req.body.latitude);
  const lng = parseFloat(req.body.longitude);

  if (isNaN(lat) || isNaN(lng) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.json({ authorized: false });
  }

  const CAFE_LAT = 34.77015823848953;
  const CAFE_LNG = 10.72152628978018;
  const distance = getDistance(lat, lng, CAFE_LAT, CAFE_LNG);

  return res.json({ authorized: distance <= 120 });
});

// Active promotion for the loyalty-card payment path only. Cash orders go
// through /demander and never reach this helper, so cash customers never get it.
async function resolveCardPromotion(totalNum) {
  const result = { percent: 0, discountedTotal: totalNum };
  try {
    const now = new Date().toISOString();
    const promo = await client.query(`
      SELECT discount_percent, minimum_purchase_amount FROM promotion
      WHERE start_date <= $1
        AND end_date >= $1
      ORDER BY discount_percent DESC
      LIMIT 1
    `, [now]);
    if (promo.rowCount > 0) {
      const percent = Number(promo.rows[0].discount_percent) || 0;
      const minimum = Number(promo.rows[0].minimum_purchase_amount || 0);
      if (percent > 0 && totalNum >= minimum) {
        result.percent = percent;
        result.discountedTotal = Math.round(totalNum * (100 - percent) / 100 * 1000) / 1000;
      }
    }
  } catch (err) {
    console.error('Promotion lookup error (non-fatal):', err);
  }
  return result;
}

// Verify QR code for card payment
app.post('/verify-qr', paymentLimiter, async (req, res) => {
  const { qrId, total } = req.body;

  if (!qrId || typeof qrId !== 'string' || qrId.length < 24) {
    return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
  }

  const totalNum = Number(total);
  if (isNaN(totalNum) || totalNum <= 0 || !Number.isFinite(totalNum)) {
    return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
  }

  const promo = await resolveCardPromotion(totalNum);

  try {
    const byToken = await client.query('SELECT * FROM qr_code WHERE token = $1', [qrId]);
    if (byToken.rowCount === 0) {
      return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
    }

    const customer = byToken.rows[0];
    if (customer.status !== 'active') {
      return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
    }

    if (Number(customer.points) < promo.discountedTotal) {
      return res.json({ success: false, error: 'INSUFFICIENT_POINTS' });
    }

    return res.json({
      success: true,
      customer: { id: customer.id, name: customer.name, points: customer.points },
      discount: promo.percent > 0
        ? { percent: promo.percent, originalTotal: totalNum, discountedTotal: promo.discountedTotal }
        : undefined,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'DB_ERROR' });
  }
});

// Process card payment (deduct points and mark receipt as paid)
app.post('/process-card-payment', paymentLimiter, async (req, res) => {
  const { qrId, idrecu, total } = req.body;

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

  const promo = await resolveCardPromotion(totalNum);
  const chargedTotal = promo.discountedTotal;

  try {
    await client.query('BEGIN');

    const byToken = await client.query('SELECT * FROM qr_code WHERE token = $1 FOR UPDATE', [qrId]);
    if (byToken.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'CUSTOMER_NOT_FOUND' });
    }

    const customerRow = byToken.rows[0];
    const currentPoints = Number(customerRow.points);
    if (currentPoints < chargedTotal) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'INSUFFICIENT_POINTS' });
    }

    await client.query('UPDATE qr_code SET points = points - $1, updated_at = NOW() WHERE id = $2', [chargedTotal, customerRow.id]);
    await client.query(
      "UPDATE recu SET type = $1, discount_percent = $2 WHERE idrecu = $3",
      ['paid', promo.percent > 0 ? promo.percent : null, idrecuNum]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      discount: promo.percent > 0
        ? { percent: promo.percent, originalTotal: totalNum, discountedTotal: chargedTotal }
        : undefined,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'DB_ERROR' });
  }
});