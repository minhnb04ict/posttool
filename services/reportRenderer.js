const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');

let browserPromise = null;
let chromiumExecutablePromise = null;

function isServerlessRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function firstExisting(paths) {
  return paths.filter(Boolean).find(candidate => {
    try { return fs.existsSync(candidate); }
    catch (_) { return false; }
  }) || null;
}

function chromeCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  return [
    process.env.CHROME_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    home && path.join(home, '.cache', 'chromium', 'chrome')
  ];
}

function findChromeExecutable() {
  const executable = firstExisting(chromeCandidates());
  if (!executable) {
    throw new Error('Không tìm thấy Chrome/Chromium/Edge trên máy local. Hãy cài Chrome/Edge hoặc đặt CHROME_EXECUTABLE_PATH.');
  }
  return executable;
}

async function getServerlessExecutable() {
  if (!chromiumExecutablePromise) {
    chromiumExecutablePromise = (async () => {
      const chromium = require('@sparticuz/chromium');
      const executablePath = await chromium.executablePath();
      if (!executablePath) throw new Error('@sparticuz/chromium không trả executablePath.');
      return { chromium, executablePath };
    })().catch(error => {
      chromiumExecutablePromise = null;
      throw error;
    });
  }
  return chromiumExecutablePromise;
}

async function getLaunchOptions() {
  if (isServerlessRuntime()) {
    const { chromium, executablePath } = await getServerlessExecutable();
    const headless = chromium.headless || 'shell';
    const args = puppeteer.defaultArgs({
      args: [...chromium.args, '--disable-dev-shm-usage', '--font-render-hinting=medium'],
      headless
    });
    return {
      executablePath,
      args,
      defaultViewport: chromium.defaultViewport || { width: 1200, height: 900 },
      headless,
      timeout: 30000,
      protocolTimeout: 45000
    };
  }

  return {
    executablePath: findChromeExecutable(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=medium'
    ],
    timeout: 30000,
    protocolTimeout: 45000
  };
}

async function invalidateBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (_) {}
  browserPromise = null;
}

async function getBrowser({ forceNew = false } = {}) {
  if (forceNew) await invalidateBrowser();
  if (!browserPromise) {
    browserPromise = (async () => puppeteer.launch(await getLaunchOptions()))();
    browserPromise.then(browser => {
      browser.once('disconnected', () => { browserPromise = null; });
    }).catch(() => { browserPromise = null; });
  }
  const browser = await browserPromise;
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser({ forceNew: true });
  }
  return browser;
}

async function waitForVisuals(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }
    const images = [...document.images];
    await Promise.all(images.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      if (typeof img.decode === 'function') return img.decode().catch(() => undefined);
      return new Promise(resolve => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      });
    }));
  });
}

async function documentSize(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      width: Math.ceil(Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth)),
      height: Math.ceil(Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight))
    };
  });
}

async function captureLongPage(page) {
  const size = await documentSize(page);
  const width = Math.min(1400, Math.max(1100, size.width));
  const height = Math.max(1, size.height);
  const chunkCssHeight = 7000;

  if (height <= 12000) {
    return Buffer.from(await page.screenshot({
      type: 'png',
      fullPage: true,
      captureBeyondViewport: true,
      omitBackground: false
    }));
  }

  const chunks = [];
  for (let y = 0; y < height; y += chunkCssHeight) {
    const h = Math.min(chunkCssHeight, height - y);
    const buffer = Buffer.from(await page.screenshot({
      type: 'png',
      captureBeyondViewport: true,
      omitBackground: false,
      clip: { x: 0, y, width, height: h }
    }));
    const meta = await sharp(buffer).metadata();
    chunks.push({ buffer, width: meta.width, height: meta.height });
  }

  const pixelWidth = Math.max(...chunks.map(c => c.width || 0));
  const pixelHeight = chunks.reduce((sum, c) => sum + (c.height || 0), 0);
  let top = 0;
  const composite = chunks.map(c => {
    const entry = { input: c.buffer, left: 0, top };
    top += c.height || 0;
    return entry;
  });

  return sharp({
    create: {
      width: pixelWidth,
      height: pixelHeight,
      channels: 3,
      background: '#ffffff'
    }
  }).composite(composite).png().toBuffer();
}

async function optimizePng(raw, targetBytes = 3.45 * 1024 * 1024) {
  let image = sharp(raw, { limitInputPixels: 160_000_000 }).flatten({ background: '#ffffff' });
  let out = await image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (out.length <= targetBytes) return out;

  const meta = await image.metadata();
  const originalWidth = meta.width || 1200;
  for (const scale of [0.92, 0.84, 0.76, 0.68]) {
    const width = Math.max(820, Math.round(originalWidth * scale));
    out = await sharp(raw, { limitInputPixels: 160_000_000 })
      .flatten({ background: '#ffffff' })
      .resize({ width, withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    if (out.length <= targetBytes) return out;
  }

  // Last resort: indexed PNG. This preserves the PNG requirement while keeping
  // Vercel responses and Apps Script uploads below practical payload limits.
  out = await sharp(raw, { limitInputPixels: 160_000_000 })
    .flatten({ background: '#ffffff' })
    .resize({ width: Math.max(760, Math.min(980, originalWidth)), withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, colours: 256, dither: 0.6 })
    .toBuffer();
  return out;
}

async function renderOnce(report) {
  const template = path.join(__dirname, '..', 'views', 'report.ejs');
  const html = await ejs.renderFile(template, { report }, { async: false });
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForVisuals(page);
    await new Promise(resolve => setTimeout(resolve, 80));
    const raw = await captureLongPage(page);
    return optimizePng(raw);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function renderReportPng(report) {
  let firstError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt > 0) await invalidateBrowser();
      return await renderOnce(report);
    } catch (error) {
      firstError = firstError || error;
      const message = String(error?.message || error);
      const likelyBrowserFailure = /browser|target|session|protocol|chrom(e|ium)|executable|socket|closed|disconnect/i.test(message);
      if (!likelyBrowserFailure || attempt >= 1) throw error;
    }
  }
  throw firstError || new Error('Không tạo được báo cáo.');
}

async function probeRenderer() {
  const startedAt = Date.now();
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent('<html><body style="margin:0;background:#fff">ok</body></html>', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.screenshot({ type: 'png' });
    return { ok: true, latencyMs: Date.now() - startedAt, ...rendererInfo() };
  } catch (error) {
    await invalidateBrowser();
    return { ok: false, latencyMs: Date.now() - startedAt, ...rendererInfo(), error: error.message };
  } finally {
    if (page) await page.close().catch(() => undefined);
  }
}

async function closeBrowser() {
  await invalidateBrowser();
}

function rendererInfo() {
  if (isServerlessRuntime()) {
    return { type: 'sparticuz-chromium', runtime: process.env.VERCEL ? 'vercel' : 'serverless' };
  }
  try { return { type: 'local-chrome', executablePath: findChromeExecutable() }; }
  catch (error) { return { type: 'chrome-not-found', error: error.message }; }
}

module.exports = {
  renderReportPng,
  closeBrowser,
  findChromeExecutable,
  rendererInfo,
  isServerlessRuntime,
  probeRenderer,
  optimizePng
};
