import crypto from 'node:crypto';
import { isIP } from 'node:net';

export const validToken = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
export const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
export const validRequestKey = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function phoneNumber(value) {
  let digits = String(value || '').replace(/[\s+().-]/g, '');
  if (/^[0-9]{8}$/.test(digits)) digits = '216' + digits;
  return /^[1-9][0-9]{9,14}$/.test(digits) ? '+' + digits : null;
}

export function sameOrigin(req, local) {
  if (req.get('sec-fetch-site') === 'cross-site') return false;
  const expected = `${local ? 'http' : 'https'}://${req.get('host')}`;
  // Origin always wins over Referer. Missing headers are allowed for API clients;
  // JSON-only writes and SameSite cookies protect browser sessions.
  if (req.get('origin')) return req.get('origin') === expected;
  if (req.get('referer')) {
    try { return new URL(req.get('referer')).origin === expected; } catch { return false; }
  }
  return true;
}

export function clientAddress(req) {
  // Only the Vercel ingress is trusted to supply this header. Never enable
  // Express's unrestricted trust-proxy setting or trust arbitrary local XFF.
  const forwarded = process.env.VERCEL === '1' ? req.get('x-vercel-forwarded-for') : null;
  return forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'unknown';
}

export function distributedLimit(pool, scope, maximum, seconds, subject = clientAddress) {
  return async (req, res, next) => {
    try {
      const key = hash(scope + ':' + subject(req));
      const result = await pool.query(`INSERT INTO app_private.rate_limits (key, bucket, hits, expires_at)
        VALUES ($1, floor(extract(epoch FROM clock_timestamp()) / $2)::bigint, 1, clock_timestamp() + $2 * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET
          bucket = EXCLUDED.bucket,
          expires_at = EXCLUDED.expires_at,
          hits = CASE WHEN rate_limits.bucket = EXCLUDED.bucket THEN rate_limits.hits + 1 ELSE 1 END
        RETURNING hits`, [key, seconds]);
      if (Number(result.rows[0].hits) > maximum) {
        res.set('Retry-After', String(seconds));
        return res.status(429).json({ success: false, error: 'RATE_LIMITED' });
      }
      next();
    } catch { res.status(503).json({ success: false, error: 'SECURITY_STORE_UNAVAILABLE' }); }
  };
}

export async function beginRequest(db, req, scope, principal) {
  const key = req.get('Idempotency-Key');
  if (!validRequestKey(key)) throw Object.assign(new Error('IDEMPOTENCY_KEY_REQUIRED'), { status: 400 });
  const digest = hash(JSON.stringify(req.body));
  // Store only a hash of the guest receipt capability, never the bearer value.
  const keyHash = hash(key);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope + keyHash]);
  const previous = await db.query('SELECT principal, digest, response FROM app_private.checkout_requests WHERE scope=$1 AND key=$2', [scope,keyHash]);
  if (previous.rowCount) {
    const row = previous.rows[0];
    if (row.principal !== principal || row.digest !== digest) throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), { status: 409 });
    return { response: row.response };
  }
  return { async save(response) {
    await db.query('INSERT INTO app_private.checkout_requests (scope,key,principal,digest,response) VALUES ($1,$2,$3,$4,$5)', [scope,keyHash,principal,digest,JSON.stringify(response)]);
  } };
}

export function validateCart(items, allowEmpty = false) {
  return Array.isArray(items) && (allowEmpty || items.length > 0) && items.length <= 100
    && items.every(item => item && typeof item === 'object' && typeof item.idname === 'string'
      && item.idname.length > 0 && item.idname.length <= 200
      && (item.optionn == null || typeof item.optionn === 'string' && item.optionn.length <= 500));
}

export function safeLog(context, error) {
  // pg errors can contain SQL parameters, phone numbers and worker payloads.
  const code = /^[A-Z0-9_]{2,40}$/.test(error?.code || '') ? error.code : 'INTERNAL';
  console.error(context, code);
}
