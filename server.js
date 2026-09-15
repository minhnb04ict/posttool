require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const apiRouter = require('./routes/api');
const { APPS_SCRIPT_URL } = require('./services/googleAppsScript');
const { closeBrowser, findChromeExecutable } = require('./services/reportRenderer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = '1.1.0';
const jsonLimit = process.env.REPORT_JSON_LIMIT || '60mb';

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use('/css', express.static(path.join(__dirname, 'public', 'css'), { maxAge: 0, etag: false }));
app.use('/js', express.static(path.join(__dirname, 'public', 'js'), { maxAge: 0, etag: false }));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '7d' }));

app.use('/api', apiRouter);

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.render('index', {
    pageTitle: 'Phiếu trả lời',
    appVersion: APP_VERSION,
    clientConfig: {
      apiUrl: '/api/task',
      imageUploadUrl: '/api/uploads/image',
      reportSubmitUrl: '/api/reports/submit',
      pdfWorkerUrl: '/vendor/pdfjs/pdf.worker.min.js'
    }
  });
});

app.get('/health', (_req, res) => {
  let chrome = null;
  try { chrome = findChromeExecutable(); } catch (_) {}
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    service: 'posttool',
    version: APP_VERSION,
    reportRenderer: chrome ? 'chromium' : 'chrome-not-found',
    appsScriptConfigured: Boolean(APPS_SCRIPT_URL)
  });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((error, _req, res, _next) => {
  console.error('[Unhandled request error]', error);
  res.status(error?.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({
    ok: false,
    error: error?.code === 'LIMIT_FILE_SIZE' ? 'Hình ảnh vượt quá dung lượng cho phép.' : 'Máy chủ gặp lỗi khi xử lý yêu cầu.',
    detail: error?.message || String(error)
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Posttool đang chạy tại http://localhost:${PORT}`);
  console.log(`Google Apps Script: ${APPS_SCRIPT_URL}`);
  try { console.log(`Report Chromium: ${findChromeExecutable()}`); }
  catch (error) { console.warn(`Cảnh báo: ${error.message}`); }
});

async function shutdown(signal) {
  console.log(`\n${signal}: đang dừng Posttool...`);
  server.close(async () => {
    await closeBrowser();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
