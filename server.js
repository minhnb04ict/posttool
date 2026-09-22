require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const apiRouter = require('./routes/api');
const gas = require('./services/googleAppsScript');
const taskCache = require('./services/taskCache');
const { closeBrowser, rendererInfo, probeRenderer } = require('./services/reportRenderer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = '1.3.3';
const isVercel = Boolean(process.env.VERCEL);
const jsonLimit = process.env.REPORT_JSON_LIMIT || '4mb';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: jsonLimit, strict: true }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  fallthrough: true
}));

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
      reportFallbackUploadUrl: '/api/reports/upload',
      reportStatusUrl: '/api/reports/status',
      pdfWorkerUrl: '/vendor/pdfjs/pdf.worker.min.js',
      maxReportRequestBytes: 3.55 * 1024 * 1024,
      reportStrategy: process.env.REPORT_STRATEGY || 'client-first',
      startupJitterMs: Math.max(0, Number(process.env.STARTUP_JITTER_MS || 350))
    }
  });
});

app.get('/health', async (req, res) => {
  const payload = {
    ok: true,
    service: 'posttool',
    version: APP_VERSION,
    runtime: {
      node: process.version,
      vercel: isVercel,
      environment: process.env.NODE_ENV || 'development'
    },
    reportRenderer: rendererInfo(),
    appsScriptConfigured: Boolean(gas.APPS_SCRIPT_URL),
    taskCache: taskCache.stats()
  };

  if (String(req.query.deep || '') === '1') {
    const [appsScript, renderer] = await Promise.all([
      gas.health(),
      probeRenderer()
    ]);
    payload.checks = { appsScript, renderer };
    payload.ok = Boolean(appsScript.ok && renderer.ok);
  }

  res.status(payload.ok ? 200 : 503).set('Cache-Control', 'no-store').json(payload);
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((error, _req, res, _next) => {
  console.error('[Unhandled request error]', error);
  const isTooLarge = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE' || error?.status === 413;
  res.status(isTooLarge ? 413 : 500).json({
    ok: false,
    code: isTooLarge ? 'PAYLOAD_TOO_LARGE' : 'SERVER_ERROR',
    fallbackRequired: isTooLarge,
    error: isTooLarge
      ? 'Dữ liệu hình ảnh quá lớn cho một lần gửi. Hệ thống sẽ thử chế độ tạo báo cáo ngay trên thiết bị.'
      : 'Máy chủ gặp lỗi khi xử lý yêu cầu.',
    detail: error?.message || String(error)
  });
});

let server = null;
if (!isVercel && require.main === module) {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Posttool đang chạy tại http://localhost:${PORT}`);
    console.log(`Google Apps Script: ${gas.APPS_SCRIPT_URL}`);
    console.log('Report renderer:', rendererInfo());
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
}

module.exports = app;
