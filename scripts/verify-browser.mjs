import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import express from 'express';
import { fileURLToPath } from 'node:url';

// Install Playwright separately or set PLAYWRIGHT_MODULE to its module URL.
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = express();
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
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
  async function pageFor({ width = 390, height = 664, count = 1, mode = 'native', torch = true, minimum = 0, percent = 20 } = {}) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(10000);
    const errors = [];
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
      if (url.pathname.startsWith('/api/loyalty/token/')) return json({ points: 100, name: 'Test' });
      if (url.pathname.startsWith('/api/loyalty/public/customer/')) return json({ card: { points: 100 }, rewards: [], activeChallenges: [] });
      if (url.pathname === '/api/loyalty/visit/start') throw new Error('Removed visit display still makes requests');
      if (url.pathname === '/verify-location') return json({ authorized: true });
      if (url.pathname === '/demander') return json({ success: true, idrecu: 1, total: 10 });
      if (url.pathname === '/process-cash-payment') { cashBody = route.request().postDataJSON(); return json({ success: true, total: 10 }); }
      return route.continue();
    });
    await page.addInitScript(({ count, mode, torch, qrFixture }) => {
      localStorage.setItem('sellamo_cart', JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: 'item-' + i, productKey: 'coffee', name: 'coffee', price: 10, img: '/css/background.jpg' }))));
      Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(ok) { ok({ coords: { latitude: 0, longitude: 0 } }); } } });
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
        track.getCapabilities = () => ({ torch });
        track.getConstraints = () => ({ facingMode: 'environment' });
        track.getSettings = () => torch ? { torch: on } : {};
        track.applyConstraints = async constraints => {
          window.__constraints.push(constraints);
          if (window.__rejectTorch) throw new Error('Torch rejected');
          on = constraints.torch;
        };
        window.__tracks.push(track);
        return stream;
      };
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
    }, { count, mode, torch, qrFixture });
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('cartCount').textContent !== '0');
    return { page, errors };
  }
  async function checkout(page) {
    await page.locator('#openCart').click();
    await page.locator('#demanderBtn').click();
    await page.locator('#paymentModal.open').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('payCard').disabled);
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
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const mode of ['native', 'fallback']) {
    for (const torch of [true, false]) {
      console.log(name, 'camera', mode, torch);
      const { page, errors } = await pageFor({ mode, torch });
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
        assert.equal(await page.locator('#qrFlashBtn').isDisabled(), true);
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
  if (process.env.WEBKIT_EXECUTABLE) {
    const safari = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE });
    try { await run(safari, 'webkit'); } finally { await safari.close(); }
  }
} finally {
  server.close();
}
