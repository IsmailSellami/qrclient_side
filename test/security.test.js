import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { getPoolOptions } from '../server/database.js';
import { clientAddress } from '../server/security.js';

const tokenA = 'a'.repeat(24), tokenB = 'b'.repeat(24);
test('auth, ownership, CSRF, errors and distributed limits', async t => {
  let hits = 0, fail = false, otpSent = 0;
  const pool = { async query(sql,args) {
    if (sql.startsWith('INSERT INTO app_private.rate_limits')) {
      if (fail) throw new Error('secret database password');
      return {rows:[{hits:++hits}],rowCount:1};
    }
    if (sql.startsWith('SELECT phone')) return {rows:[{phone:args[0] === tokenA ? '20123456' : '20999999'}],rowCount:1};
    if (sql.includes('FROM qr_code')) return {rows:[{id:1,name:'A',phone:'20123456',points:10,status:'active'}],rowCount:1};
    throw new Error('Unexpected query');
  } };
  const user = {id:'user-a', phone:'21620123456',phone_confirmed_at:'2026-10-26'};
  const authFactory = () => ({
    async getUser(jwt) { return {data:{user:jwt === 'valid' ? user : null},error:jwt !== 'valid'}; },
    async signInWithOtp({phone}) { assert.equal(phone,'+21620123456');otpSent++;return {}; },
    async verifyOtp({token}) { return token === '123456' ? {data:{user,session:{access_token:'valid',expires_in:3600}}} : {error:true}; },
  });
  const app = createApp({pool,authFactory});
  const server = app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = 'http://127.0.0.1:'+server.address().port;
  async function request(path,{body,cookie,headers={},raw}={}) {
    hits=0;
    const r = await fetch(base+path,{method:body || raw ? 'POST' : 'GET',headers:{...(body ? {'Content-Type':'application/json'}:{}),...(cookie?{Cookie:'__Host-customer_session='+cookie}:{}),...headers},body:raw || (body?JSON.stringify(body):undefined)});
    return {status:r.status,headers:r.headers,body:await r.json()};
  }
  await t.test('all customer data routes reject anonymous and forged sessions',async()=>{
    for(const route of ['/api/loyalty/token/','/api/loyalty/public/customer/','/api/loyalty/public/transactions/']) {
      assert.equal((await request(route+tokenA)).status,401);
      assert.equal((await request(route+tokenA,{cookie:'forged'})).status,401);
      assert.equal((await request(route+tokenB,{cookie:'valid'})).status,403);
    }
    for(const route of ['/verify-qr','/process-card-payment','/api/loyalty/public/redeem-reward']) {
      const body=route.includes('redeem')?{token:tokenA,rewardId:3}:{qrId:tokenA,total:1};
      assert.equal((await request(route,{body})).status,401);
      assert.equal((await request(route,{body:{...body,token:tokenB,qrId:tokenB},cookie:'valid'})).status,403);
    }
    assert.equal((await request('/api/loyalty/token/'+tokenA,{cookie:'valid'})).status,200);
  });
  await t.test('OTP proof issues restricted cookie; wrong code fails',async()=>{
    assert.equal((await request('/api/auth/start',{body:{token:tokenA}})).status,200);
    assert.equal(otpSent,1);
    assert.equal((await request('/api/auth/verify',{body:{token:tokenA,code:'000000'}})).status,401);
    const verified = await request('/api/auth/verify',{body:{token:tokenA,code:'123456'}});
    assert.equal(verified.status,200);
    assert.match(verified.headers.get('set-cookie'),/__Host-customer_session=valid;.*HttpOnly; Secure; SameSite=Strict/i);
    assert.equal(verified.body.access_token,undefined);
  });
  await t.test('foreign Origin cannot be overridden with a same-host Referer',async()=>{
    const r=await request('/api/auth/start',{body:{token:tokenA},headers:{Origin:'https://evil.example',Referer:'https://127.0.0.1:'+server.address().port+'/'}});
    assert.equal(r.status,403);
    assert.equal(r.headers.get('access-control-allow-origin'),null);
    assert.equal((await request('/api/auth/start',{body:{},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await request('/api/auth/start',{raw:'token=x',headers:{'Content-Type':'application/x-www-form-urlencoded'}})).status,415);
  });
  await t.test('malformed/oversized JSON gets generic JSON errors',async()=>{
    for(const [raw,status] of [['{',400],[JSON.stringify({x:'x'.repeat(40_000)}),413]]) {
      const r=await request('/api/auth/start',{raw,headers:{'Content-Type':'application/json'}});
      assert.equal(r.status,status);assert.equal(r.body.error,'INVALID_REQUEST');
    }
  });
  await t.test('shared limiter rejects exhaustion and fails closed on store errors',async()=>{
    hits=120;
    const r=await fetch(base+'/verify-location',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(r.status,429);
    fail=true;
    const failed=await request('/verify-location',{body:{}});
    assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed),/password/);fail=false;
  });
  await t.test('sensitive response is not cacheable and CSP preserves camera',async()=>{
    const r=await request('/api/loyalty/token/'+tokenA,{cookie:'valid'});
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal(r.headers.get('referrer-policy'),'no-referrer');
    assert.match(r.headers.get('content-security-policy'),/script-src 'self';/);
    assert.match(r.headers.get('permissions-policy'),/camera=\(self\)/);
  });
});

test('database TLS cannot be weakened through connection string options',()=>{
  const options=getPoolOptions('postgresql://user:password@host/db?sslmode=no-verify&ssl=false&uselibpqcompat=true');
  assert.equal(options.ssl.rejectUnauthorized,true);
  assert.equal(new URL(options.connectionString).search,'');
});
test('local clients cannot spoof their address with forwarded headers',()=>{
  const old=process.env.VERCEL;delete process.env.VERCEL;
  try { assert.equal(clientAddress({get:()=> '1.2.3.4',socket:{remoteAddress:'127.0.0.1'}}),'127.0.0.1'); }
  finally { if(old!==undefined)process.env.VERCEL=old; }
});
