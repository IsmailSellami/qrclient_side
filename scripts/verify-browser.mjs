import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import https from 'node:https';
import { createApp } from '../server/app.js';

// Install Playwright separately or set PLAYWRIGHT_MODULE to its module URL.
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createApp({ pool: { async query() { throw new Error('Unexpected database access in browser fixture'); } }, local: true });
const server = process.env.BROWSER_TEST_CERT && process.env.BROWSER_TEST_KEY
  ? https.createServer({ cert: await readFile(process.env.BROWSER_TEST_CERT), key: await readFile(process.env.BROWSER_TEST_KEY) },app).listen(0,'127.0.0.1')
  : app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = (process.env.BROWSER_TEST_CERT ? 'https' : 'http') + '://127.0.0.1:' + server.address().port;
await mkdir('artifacts', { recursive: true });
let decoderSource, qrFixture;
if (process.env.HTML5_QRCODE_PATH && process.env.QR_GENERATOR_PATH) {
  decoderSource = await readFile(process.env.HTML5_QRCODE_PATH, 'utf8');
  const sandbox = {};
  vm.runInNewContext(await readFile(process.env.QR_GENERATOR_PATH, 'utf8'), sandbox);
  const qr = sandbox.qrcode(0, 'M');
  qr.addData('a'.repeat(24));
  qr.make();
  qrFixture = qr.createDataURL(8, 32);
}

async function run(browser, name) {
  let cashBody;
  async function pageFor({ width = 390, height = 664, count = 1, mode = 'native', torch = true, torchCapabilities = true, geoMode = 'fresh', minimum = 0, percent = 20, requireOtp = false, malicious = false } = {}) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: !!process.env.BROWSER_TEST_CERT });
    page.setDefaultTimeout(10000);
    const errors = [];
    let verified = !requireOtp;
    let locationCalls = 0;
    const payload = '<img src=x onerror=window.__xss=1>';
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({ json: body });
      if (mode === 'real-fallback' && url.href.includes('html5-qrcode.min.js')) return route.fulfill({ contentType: 'text/javascript', body: decoderSource });
      if (url.origin !== base) return route.abort();
      if (url.pathname === '/getdata') return json([{ idcat: 'Coffee' }]);
      if (url.pathname === '/product') return json([{ idname: 'coffee', idcat: 'Coffee', price: 10, img: '/css/background.jpg' }]);
      if (url.pathname === '/api/promotions/active') return json({ active: !!percent, discountPercent: percent, minimumPurchaseAmount: minimum });
      if (url.pathname === '/api/promotions/banner') return json({ status: 'none' });
      if (url.pathname === '/api/loyalty/public/config') return json({ rewards: [], challenges: [], packages: [] });
      if (url.pathname === '/api/auth/start') return json({success:true});
      if (url.pathname === '/api/auth/logout') { verified=false;return json({success:true}); }
      if (url.pathname === '/api/auth/verify') {
        assert.equal(route.request().postDataJSON().code,'123456');
        verified=true;return json({success:true});
      }
      if (url.pathname.startsWith('/api/loyalty/token/')) return verified ? json({ points: 100, name: 'Test' }) : route.fulfill({status:401,json:{error:'AUTH_REQUIRED'}});
      if (url.pathname.startsWith('/api/loyalty/public/customer/')) return json({ card: { points: 100, name: malicious ? payload : 'Test' }, rewards: malicious ? [{ id:3, rewardName:payload,mysteryResult:payload,rewardType:'free_item',productId:payload,isRedeemed:false }] : [], activeChallenges: [] });
      if (url.pathname === '/api/loyalty/visit/start') throw new Error('Removed visit display still makes requests');
      if (url.pathname === '/verify-location') { locationCalls++; return json({ authorized: true }); }
      if (url.pathname === '/demander') {
        assert.match(route.request().headers()['idempotency-key'],/^[a-f0-9-]{36}$/);
        return json({ success: true, idrecu: 1, total: 10 });
      }
      if (url.pathname === '/process-cash-payment') { cashBody = route.request().postDataJSON(); return json({ success: true, total: 10 }); }
      return route.continue();
    });
    await page.addInitScript(({ count, mode, torch, torchCapabilities, geoMode, qrFixture }) => {
      localStorage.setItem('sellamo_cart', JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: 'item-' + i, productKey: 'coffee', name: 'coffee', price: 10, img: '/css/background.jpg' }))));
      Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(ok, fail, options) {
        window.__geoOptions = options;
        if (geoMode === 'denied') fail({ code: 1 });
        else ok({ coords: { latitude: 0, longitude: 0, accuracy: 5 }, timestamp: Date.now() - (geoMode === 'stale' ? 30000 : 0) });
      } } });
      window.__tracks = [];
      window.__constraints = [];
      window.__makeStream = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = mode === 'real-fallback' ? 640 : 160;
        canvas.getContext('2d').fillRect(0, 0, 160, 160);
        const stream = canvas.captureStream(10);
        window.__drawFrame = () => canvas.getContext('2d').fillRect(0, 0, 160, 160);
        if (mode === 'real-fallback') {
          const fixture = new Image();
          fixture.src = qrFixture;
          window.__drawFrame = () => {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, 640, 640);
            if (fixture.complete) ctx.drawImage(fixture, 160, 160, 320, 320);
          };
        }
        setInterval(() => {
          canvas.getContext('2d').fillStyle = 'rgb(' + (Date.now() % 255) + ',0,0)';
          window.__drawFrame();
        }, 100);
        const track = stream.getVideoTracks()[0];
        let on = false;
        track.getCapabilities = () => torchCapabilities ? { torch } : {};
        track.getConstraints = () => ({ facingMode: 'environment' });
        track.getSettings = () => torch ? { torch: on } : {};
        track.applyConstraints = async constraints => {
          window.__constraints.push(constraints);
          const requestedTorch = constraints.torch ?? constraints.advanced?.[0]?.torch;
          if (window.__rejectTorch || (!torch && requestedTorch)) throw new Error('Torch rejected');
          on = requestedTorch;
        };
        window.__tracks.push(track);
        return stream;
      };
      // Windows WebKit omits mediaDevices even though tests provide synthetic
      // streams. This is a fixture, not a production browser capability claim.
      if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        if (mode === 'denied') throw new Error('Permission denied');
        if (mode === 'delayed') await new Promise(resolve => { window.__allowCamera = resolve; });
        return window.__makeStream();
      } });
      if (mode === 'fallback' || mode === 'fallback-delayed') {
        delete window.BarcodeDetector;
        window.Html5QrcodeSupportedFormats = { QR_CODE: 0 };
        window.Html5Qrcode = class {
          async start(_, __, onScan) {
            this.video = document.createElement('video');
            this.video.setAttribute('playsinline', '');
            this.video.muted = true;
            document.getElementById('qr-reader').appendChild(this.video);
            if (mode === 'fallback-delayed') await new Promise(resolve => { window.__allowCamera = resolve; });
            this.video.srcObject = window.__makeStream();
            await this.video.play();
            window.__triggerScan = () => onScan('a'.repeat(24));
          }
          async stop() { this.video?.srcObject?.getTracks().forEach(track => track.stop()); window.__html5Stopped = true; }
          clear() { this.video?.remove(); }
        };
      } else if (mode !== 'real-fallback') {
        window.BarcodeDetector = class {
          static async getSupportedFormats() { return ['qr_code']; }
          async detect() { window.__detectCalls = (window.__detectCalls || 0) + 1; return window.__scan ? [{ rawValue: 'a'.repeat(24) }] : []; }
        };
      } else { delete window.BarcodeDetector; }
    }, { count, mode, torch, torchCapabilities, geoMode, qrFixture });
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('cartCount').textContent !== '0');
    return { page, errors, getLocationCalls: () => locationCalls };
  }
  async function checkout(page) {
    await page.locator('#openCart').click();
    await page.locator('#demanderBtn').click();
    await page.locator('#paymentModal.open').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('payCard').disabled);
    assert.deepEqual(await page.evaluate(() => window.__geoOptions), {
      enableHighAccuracy: true, timeout: 8000, maximumAge: 0
    });
  }
  if (!process.env.BROWSER_SECURITY_ONLY) {
  for (const geoMode of ['denied', 'stale']) {
    const { page, getLocationCalls } = await pageFor({ geoMode });
    await checkout(page);
    assert.equal(await page.locator('#paymentModal').isVisible(), true, 'location must not block checkout');
    assert.equal(getLocationCalls(), 0, 'denied or stale fixes must not be sent to the server');
    if (geoMode === 'denied') assert.match(await page.locator('#toast').innerText(), /Autorisez la localisation/);
    await page.close();
  }
  for (const [width, height] of [[320, 480], [360, 640], [390, 664], [844, 390], [390, 280], [1440, 900]]) {
    console.log(name, 'cart', width, height);
    const { page, errors } = await pageFor({ width, height, count: 30 });
    await page.locator('#openCart').click();
    await page.locator('#demanderBtn').scrollIntoViewIfNeeded();
    const button = await page.locator('#demanderBtn').boundingBox();
    assert(button.y >= 0 && button.y + button.height <= height + 1, name + ' button reachable ' + width + 'x' + height);
    await page.locator('.cart-item').last().scrollIntoViewIfNeeded();
    const last = await page.locator('.cart-item').last().boundingBox();
    assert(last.y < height && last.y + last.height > 0, 'last item reachable');
    await page.locator('.cart-item').first().scrollIntoViewIfNeeded();
    assert((await page.locator('.cart-item').first().boundingBox()).y >= 0, 'first item reachable');
    if (height === 480) await page.screenshot({ path: 'artifacts/' + name + '-cart-small.png' });
    // Resize as when browser chrome/keyboard reduces the visible viewport.
    await page.setViewportSize({ width, height: Math.min(height, 420) });
    await page.locator('#demanderBtn').scrollIntoViewIfNeeded();
    const resized = await page.locator('#demanderBtn').boundingBox();
    assert(resized.y + resized.height <= Math.min(height, 420) + 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const [percent, minimum, expectedCard] of [[20, 0, '8.000'], [0, 0, '10.000'], [20, 11, '10.000']]) {
    console.log(name, 'checkout', percent, minimum);
    const { page, errors } = await pageFor({ percent, minimum });
    await checkout(page);
    assert.match(await page.locator('#paymentTotalAmount').innerText(), /10\.000/);
    assert.match(await page.locator('#payCash').innerText(), /10\.000/);
    assert((await page.locator('#payCard').innerText()).includes(expectedCard));
    await page.locator('#payCash').click();
    await page.locator('#cashOk').click();
    await page.waitForFunction(() => document.getElementById('cartCount').textContent === '0');
    assert.equal(cashBody.total, 10);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sellamo_checkout')),null);
    assert.deepEqual(errors, []);
    await page.close();
  }
  if (name === 'webkit') {
    const probe = await browser.newPage();
    const mediaFixtureAvailable = await probe.evaluate(() => typeof MediaStream !== 'undefined' && typeof document.createElement('canvas').captureStream === 'function');
    await probe.close();
    if (!mediaFixtureAvailable) {
      console.log('webkit: cart/layout and cash checkout passed; scanner/auth UI tests SKIPPED because this build lacks MediaStream/canvas.captureStream. Real Safari camera remains unverified.');
      return;
    }
  }
  for (const mode of ['native', 'fallback']) {
    for (const { torch, torchCapabilities } of [
      { torch: true, torchCapabilities: true },
      { torch: true, torchCapabilities: false },
      { torch: false, torchCapabilities: true }
    ]) {
      console.log(name, 'camera', mode, torch);
      const { page, errors } = await pageFor({ mode, torch, torchCapabilities });
      await checkout(page);
      await page.locator('#payCard').click();
      await page.locator('#qrFlashBtn').waitFor({ state: 'visible' });
      if (torch) {
        assert.equal(await page.locator('#qrFlashBtn').innerText(), 'Allumer la lampe');
        await page.locator('#qrFlashBtn').click();
        assert.equal(await page.locator('#qrFlashBtn').innerText(), 'Éteindre la lampe');
        const constraints = await page.evaluate(() => window.__constraints.at(-1));
        assert.equal(constraints.torch, true);
        assert.equal(constraints.facingMode, 'environment');
        if (mode === 'native') await page.screenshot({ path: 'artifacts/' + name + '-scanner-torch.png' });
        await page.locator('#qrFlashBtn').click();
        assert.equal(await page.locator('#qrFlashBtn').innerText(), 'Allumer la lampe');
        await page.locator('#qrFlashBtn').click();
      } else {
        assert.equal(await page.locator('#qrFlashBtn').isDisabled(), false);
        await page.locator('#qrFlashBtn').click();
        assert.match(await page.locator('#qrFlashBtn').innerText(), /indisponible/);
      }
      await page.locator('#qrClose').click();
      assert(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended')));
      if (torch) assert.equal(await page.evaluate(() => window.__constraints.at(-1).torch), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
    const { page } = await pageFor({ mode });
    await checkout(page);
    await page.locator('#payCard').click();
    await page.locator('#qrFlashBtn').waitFor({ state: 'visible' });
    if (mode === 'native') await page.evaluate(() => { window.__scan = true; window.__drawFrame(); });
    else await page.evaluate(() => window.__triggerScan());
    try { await page.locator('#confirmPaymentBtn').waitFor({ state: 'visible' }); }
    catch (error) { console.log(await page.evaluate(() => ({ detectCalls: window.__detectCalls, result: document.getElementById('qrResult').textContent, camera: document.getElementById('qrCameraError').textContent }))); throw error; }
    assert.match(await page.locator('#confirmPaymentBtn').innerText(), /8\.000/);
    assert(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended')));
    assert.equal(await page.locator('#qr-reader').isVisible(), false);
    await page.close();
  }
  for (const mode of ['delayed', 'fallback-delayed']) {
    console.log(name, 'pending camera', mode);
    const { page, errors } = await pageFor({ mode });
    await checkout(page);
    await page.locator('#payCard').click();
    await page.waitForFunction(() => !!window.__allowCamera);
    await page.locator('#qrClose').click();
    await page.evaluate(() => window.__allowCamera());
    await page.waitForFunction(() => window.__tracks.length && window.__tracks.every(track => track.readyState === 'ended'));
    assert.equal(await page.locator('#qrModal').getAttribute('aria-hidden'), 'true');
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { page } = await pageFor({ mode: 'denied' });
    await checkout(page);
    await page.locator('#payCard').click();
    await page.locator('#qrRetryBtn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#qrFlashBtn').isVisible(), false);
    await page.close();
  }
  {
    const { page, errors } = await pageFor();
    await checkout(page);
    await page.locator('#payCard').click();
    await page.locator('#qrFlashBtn').waitFor({ state: 'visible' });
    await page.evaluate(() => window.__rejectTorch = true);
    await page.locator('#qrFlashBtn').click();
    assert.match(await page.locator('#qrFlashBtn').innerText(), /indisponible/);
    assert(await page.evaluate(() => window.__tracks[0].readyState === 'live'));
    assert.deepEqual(errors, []);
    await page.close();
  }
  }
  {
    console.log(name, 'SMS verification UI and escaped customer/reward data');
    const {page,errors}=await pageFor({requireOtp:true,malicious:true});
    await checkout(page);
    await page.locator('#payCard').click();
    await page.locator('#qrFlashBtn').waitFor({state:'visible'});
    await page.evaluate(()=> {window.__scan=true;window.__drawFrame();});
    try { await page.getByRole('button',{name:'Recevoir un code SMS'}).click(); }
    catch (error) {
      console.log(await page.locator('#qrResult').evaluate(el=>({html:el.innerHTML,display:getComputedStyle(el).display,detect:window.__detectCalls,scan:window.__scan})),errors);
      await page.screenshot({path:'artifacts/otp-debug.png'});throw error;
    }
    await page.getByRole('textbox',{name:'Code SMS'}).fill('123456');
    await page.getByRole('button',{name:'Vérifier le code'}).click();
    await page.locator('#confirmPaymentBtn').waitFor({state:'visible'});
    assert.equal(await page.locator('#loyaltyInfo img, #rewardSelection img').count(),0);
    assert.equal(await page.evaluate(()=>window.__xss),undefined);
    assert((await page.locator('#loyaltyInfo').innerText()).includes('<img'));
    await page.locator('.reward-card').click();
    assert.equal(await page.locator('#rewardFreeOptions img').count(),0);
    await page.getByRole('button',{name:'Déconnecter la carte'}).click();
    await page.getByRole('button',{name:'Recevoir un code SMS'}).waitFor({state:'visible'});
    assert.deepEqual(errors,[]);
    await page.close();
  }
  {
    const {page}=await pageFor();
    await checkout(page);
    const firstKey=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sellamo_checkout')).key);
    await page.locator('#paymentClose').click();
    await checkout(page);
    assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sellamo_checkout')).key),firstKey);
    await page.reload();
    await checkout(page);
    assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sellamo_checkout')).key),firstKey);
    await page.close();
  }
  if (decoderSource) {
    console.log(name, 'real html5-qrcode decode');
    const { page, errors } = await pageFor({ mode: 'real-fallback', torch: false });
    await checkout(page);
    await page.locator('#payCard').click();
    await page.locator('#confirmPaymentBtn').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmPaymentBtn').innerText(), /8\.000/);
    assert(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended')));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(name + ': responsive cart, checkout totals, native/fallback scans, torch states, close races and denied camera passed');
}

try {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try { await run(browser, 'chromium'); } finally { await browser.close(); }
  if (process.env.WEBKIT_EXECUTABLE || process.env.TEST_WEBKIT === '1') {
    const safari = await webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
    try { await run(safari, 'webkit'); } finally { await safari.close(); }
  }
} finally {
  server.close();
}
