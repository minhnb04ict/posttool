const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');

let browserPromise = null;

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
    throw new Error(
      'Không tìm thấy Chrome/Chromium/Edge. Hãy cài Chrome hoặc đặt CHROME_EXECUTABLE_PATH trong .env.'
    );
  }
  return executable;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: findChromeExecutable(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=medium'
      ]
    });
    browserPromise.then(browser => {
      browser.once('disconnected', () => { browserPromise = null; });
    }).catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

async function waitForVisuals(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const images = [...document.images];
    await Promise.all(images.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      if (typeof img.decode === 'function') return img.decode().catch(() => undefined);
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
  });
}

async function renderReportPng(report) {
  const template = path.join(__dirname, '..', 'views', 'report.ejs');
  const html = await ejs.renderFile(template, { report }, { async: false });
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await waitForVisuals(page);
    await new Promise(resolve => setTimeout(resolve, 80));

    const raw = await page.screenshot({
      type: 'png',
      fullPage: true,
      captureBeyondViewport: true,
      omitBackground: false
    });

    return sharp(raw)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (_) {}
  browserPromise = null;
}

module.exports = {
  renderReportPng,
  closeBrowser,
  findChromeExecutable
};
