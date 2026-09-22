require('dotenv').config();
const fs = require('fs');
const path = require('path');
const gas = require('../services/googleAppsScript');
const { probeRenderer, closeBrowser } = require('../services/reportRenderer');

(async () => {
  const results = [];
  const major = Number(process.versions.node.split('.')[0]);
  results.push({ name: 'Node.js >= 20', ok: major >= 20, detail: process.version });

  for (const rel of [
    'public/vendor/pdfjs/pdf.min.js',
    'public/vendor/pdfjs/pdf.worker.min.js',
    'public/vendor/html2canvas/html2canvas.min.js',
    'public/vendor/axios/axios.min.js'
  ]) {
    const full = path.join(__dirname, '..', rel);
    results.push({ name: rel, ok: fs.existsSync(full), detail: fs.existsSync(full) ? 'OK' : 'Missing - run npm install' });
  }

  const gasHealth = await gas.health();
  results.push({ name: 'Google Apps Script', ok: Boolean(gasHealth.ok), detail: JSON.stringify(gasHealth) });

  const renderer = await probeRenderer();
  results.push({ name: 'Report renderer', ok: Boolean(renderer.ok), detail: JSON.stringify(renderer) });

  console.table(results);
  await closeBrowser();
  if (results.some(item => !item.ok)) process.exitCode = 1;
})().catch(async error => {
  console.error(error);
  await closeBrowser().catch(() => undefined);
  process.exitCode = 1;
});
