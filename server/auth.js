import { phoneNumber, validToken } from './security.js';

const cookieName = local => local ? 'customer_session' : '__Host-customer_session';
export function installCustomerAuth(app, { pool, authFactory, local, otpLimiter, tokenLimiter }) {
  async function cardPhone(token) {
    if (!validToken(token)) return null;
    const result = await pool.query("SELECT phone FROM qr_code WHERE token=$1 AND status='active'", [token]);
    return phoneNumber(result.rows[0]?.phone);
  }
  const options = { httpOnly: true, secure: !local, sameSite: 'strict', path: '/' };
  app.post('/api/auth/start', otpLimiter, tokenLimiter, async (req,res) => {
    if (!authFactory) return res.status(503).json({ error: 'SMS_UNAVAILABLE' });
    const phone = await cardPhone(req.body.token);
    if (phone && authFactory) {
      const { error } = await authFactory().signInWithOtp({ phone });
      if (error) return res.status(503).json({ error: 'SMS_UNAVAILABLE' });
    }
    // Never include the registered phone or card details in this response.
    res.json({ success: true });
  });
  app.post('/api/auth/verify', otpLimiter, tokenLimiter, async (req,res) => {
    if (!/^[0-9]{6,10}$/.test(req.body.code || '')) return res.status(400).json({ error: 'INVALID_CODE' });
    const phone = await cardPhone(req.body.token);
    if (!phone || !authFactory) return res.status(401).json({ error: 'AUTH_FAILED' });
    const { data, error } = await authFactory().verifyOtp({ phone, token: req.body.code, type: 'sms' });
    if (error || !data?.session?.access_token || !data.user?.phone_confirmed_at || phoneNumber(data.user.phone) !== phone) {
      return res.status(401).json({ error: 'AUTH_FAILED' });
    }
    res.cookie(cookieName(local), data.session.access_token, { ...options, maxAge: Math.min(data.session.expires_in || 3600,3600) * 1000 });
    res.json({ success: true });
  });
  app.post('/api/auth/logout', (_req,res) => { res.clearCookie(cookieName(local),options); res.json({success:true}); });

  return async function requireCustomer(req,res,next) {
    const raw = String(req.get('cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName(local) + '='));
    if (!raw || !authFactory) return res.status(401).json({ success:false, error:'AUTH_REQUIRED' });
    let jwt;
    try { jwt = decodeURIComponent(raw.slice(raw.indexOf('=')+1)); } catch { return res.status(401).json({error:'AUTH_REQUIRED'}); }
    const { data, error } = await authFactory().getUser(jwt);
    const user = data?.user;
    const token = req.params.token || req.body?.token || req.body?.qrId;
    if (error || !user?.id || !user.phone_confirmed_at || !validToken(token)) return res.status(401).json({ success:false, error:'AUTH_REQUIRED' });
    const phone = await cardPhone(token);
    if (!phone || phoneNumber(user.phone) !== phone) return res.status(403).json({ success:false, error:'FORBIDDEN' });
    req.customerUser = user.id;
    req.customerPhone = phone;
    next();
  };
}
