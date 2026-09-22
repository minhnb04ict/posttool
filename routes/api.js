const express = require('express');
const multer = require('multer');
const contentDisposition = require('content-disposition');
const upload = require('../middleware/imageUpload');
const gas = require('../services/googleAppsScript');
const taskCache = require('../services/taskCache');

const router = express.Router();

// Multer 2.x requires byte limits to be integers. Keep this below Vercel's
// request-body ceiling and never pass a floating-point value here.
const FALLBACK_REPORT_MAX_BYTES = 3_700_000;

const fallbackReportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FALLBACK_REPORT_MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/^image\/png$/i.test(String(file.mimetype || ''))) return cb(new Error('Báo cáo fallback phải là PNG.'));
    cb(null, true);
  }
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeText(value, max = 10000) {
  return String(value ?? '').slice(0, max);
}

function safeFilePart(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\.+$/g, '')
    .slice(0, 180)
    .trim();
}

function safeDataImages(list, maxCount = 20, maxCharsEach = 3_500_000) {
  return (Array.isArray(list) ? list : [])
    .slice(0, maxCount)
    .filter(item => typeof item === 'string' && item.length <= maxCharsEach && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(item));
}

function normalizeLayout(layout) {
  const value = String(layout || '').toLowerCase();
  if (value.includes('grid')) return 'grid';
  if (value.includes('split')) return 'split';
  if (value.includes('single')) return 'single-page';
  return 'vertical';
}

function buildReportPayload(body) {
  const studentName = safeText(body.studentName, 180).trim();
  const studentClass = safeText(body.studentClass, 60).trim().toUpperCase();
  const title = safeText(body.title, 300).trim() || 'Bài học';
  const content = safeText(body.content, 20000);
  if (!studentName || !studentClass) throw new Error('Thiếu Họ và tên hoặc Lớp.');

  const answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 30).map((answer, index) => ({
    label: safeText(answer?.label, 250).trim() || `Ô văn bản ${index + 1}`,
    text: safeText(answer?.text, 30000),
    images: safeDataImages(answer?.images, 12, 2_400_000)
  }));

  // Client illustrations are mainly the currently viewed PDF page snapshots.
  // Normal List Image files are resolved server-side through Apps Script to
  // avoid sending base64 illustrations through the browser/Vercel request.
  const clientIllustrations = (Array.isArray(body.illustrations) ? body.illustrations : []).slice(0, 12)
    .map(item => ({
      dataUrl: typeof item?.dataUrl === 'string' && item.dataUrl.length <= 2_800_000 && /^data:image\//i.test(item.dataUrl) ? item.dataUrl : '',
      alt: safeText(item?.alt, 180),
      caption: safeText(item?.caption, 180)
    }))
    .filter(item => item.dataUrl);

  const baseName = safeFilePart(body.baseName) || `${safeFilePart(studentClass)}_${safeFilePart(studentName)}_${safeFilePart(title)}`;
  const submissionId = safeText(body.submissionId, 160).trim();

  return {
    studentName,
    studentClass,
    title,
    content,
    layout: normalizeLayout(body.layout),
    folderUrl: safeText(body.folderUrl, 2000).trim(),
    listImage: safeText(body.listImage, 12000).trim(),
    baseName,
    submissionId,
    localAttempt: Math.max(1, Number.parseInt(body.localAttempt, 10) || 1),
    answers,
    illustrations: clientIllustrations
  };
}

async function resolveServerIllustrations(report) {
  if (!report.listImage) return report;
  try {
    const data = await gas.postJson({ action: 'resolveIllustrations', listImage: report.listImage }, { timeoutMs: 60000, retries: 1 });
    const serverImages = [];
    for (const [index, item] of (Array.isArray(data?.images) ? data.images : []).slice(0, 12).entries()) {
      if (!String(item?.dataUrl || '').startsWith('data:image/')) continue;
      try {
        const compact = await compressIllustrationDataUrl(item.dataUrl, 650 * 1024);
        if (compact) serverImages.push({ dataUrl: compact, alt: `Hình minh họa ${index + 1}`, caption: '' });
      } catch (imageError) {
        console.warn('[compress illustration]', imageError.message);
      }
    }
    report.illustrations = [...serverImages, ...report.illustrations].slice(0, 16);
  } catch (error) {
    // Report generation must continue even if one external illustration is unavailable.
    console.warn('[resolveServerIllustrations]', error.message);
  }
  return report;
}


function compressIllustrationDataUrl(dataUrl, targetBytes = 650 * 1024) {
  const value = String(dataUrl || '');
  if (!value.startsWith('data:image/')) return '';
  // Vercel-safe build avoids native Sharp. Keep already-small images only.
  // Large illustrations remain available in the browser and are rendered there.
  const estimatedBytes = Math.floor(value.length * 0.75);
  return estimatedBytes <= targetBytes ? value : '';
}

async function uploadPngToDrive({ png, folderUrl, baseName, submissionId = '', preferredAttempt = 1 }) {
  const payload = {
    action: 'uploadReport',
    folderUrl,
    baseName,
    submissionId,
    preferredAttempt: Math.max(1, Number.parseInt(preferredAttempt, 10) || 1),
    imageData: `data:image/png;base64,${png.toString('base64')}`
  };

  try {
    // Upload la thao tac tao file, khong retry mu quang de tranh tao ban trung.
    // Apps Script dung submissionId de bao dam idempotency.
    return await gas.postJson(payload, { timeoutMs: 65000, retries: 0 });
  } catch (uploadError) {
    // Co the Drive da tao file nhung response bi mat/timeout. Kiem tra lai
    // bang submissionId truoc khi coi upload la that bai.
    if (submissionId) {
      try {
        const status = await gas.postJson({
          action: 'findSubmission',
          folderUrl,
          baseName,
          submissionId
        }, { timeoutMs: 18000, retries: 1 });
        if (status?.found && status?.fileId) return status;
      } catch (statusError) {
        console.warn('[findSubmission after upload error]', statusError.message);
      }
    }
    throw uploadError;
  }
}

router.get('/task', async (req, res) => {
  try {
    const force = String(req.query?.fresh || '') === '1';
    const query = { ...req.query };
    if (!force) delete query.fresh;

    const upstream = await taskCache.getTask(query, { force });
    const isStale = upstream.cacheStatus === 'STALE';

    res.status(upstream.status)
      .set('Cache-Control', 'no-store, max-age=0')
      .set('X-Posttool-Task-Cache', upstream.cacheStatus || 'MISS')
      .set('X-Posttool-Task-Stale', isStale ? '1' : '0');

    // Trình duyệt luôn kiểm tra lại, còn CDN/Vercel chỉ giữ dữ liệu vài giây.
    // Điều này giúp 32 máy mở đồng thời dùng chung một response thay vì dội
    // hàng chục request xuống Google Apps Script.
    if (!force) {
      res.set('CDN-Cache-Control', 'public, max-age=2, stale-if-error=300');
      res.set('Vercel-CDN-Cache-Control', 'public, max-age=2, stale-if-error=300');
    }

    res.type(upstream.contentType).send(upstream.body);
  } catch (error) {
    console.error('[GET /api/task]', error);
    res.status(502).set('Cache-Control', 'no-store').json({
      ok: false,
      error: 'Không kết nối được Google Apps Script.',
      detail: error.message
    });
  }
});

router.post('/task', async (req, res) => {
  try {
    const upstream = await gas.postRaw(req.body || {});
    res.status(upstream.status)
      .set('Cache-Control', 'no-store, max-age=0')
      .type(upstream.contentType)
      .send(upstream.body);
  } catch (error) {
    console.error('[POST /api/task]', error);
    res.status(502).json({ ok: false, error: 'Không gửi được dữ liệu tới Google Apps Script.', detail: error.message });
  }
});


router.post('/media/illustrations', async (req, res) => {
  try {
    const listImage = safeText(req.body?.listImage, 12000).trim();
    if (!listImage) return res.json({ ok: true, images: [] });
    const data = await gas.postJson({ action: 'resolveIllustrations', listImage }, { timeoutMs: 60000, retries: 1 });
    const images = [];
    let estimatedJsonBytes = 0;
    for (const item of (Array.isArray(data?.images) ? data.images : []).slice(0, 12)) {
      if (!String(item?.dataUrl || '').startsWith('data:image/')) continue;
      const compressed = await compressIllustrationDataUrl(item.dataUrl);
      if (!compressed) continue;
      estimatedJsonBytes += compressed.length;
      if (estimatedJsonBytes > 3_000_000) break;
      images.push({ dataUrl: compressed, sourceUrl: safeText(item?.sourceUrl, 2000), name: safeText(item?.name, 200) });
    }
    res.set('Cache-Control', 'no-store').json({ ok: true, images, warnings: data?.warnings || [] });
  } catch (error) {
    console.error('[POST /api/media/illustrations]', error);
    res.status(502).json({ ok: false, error: 'Không chuẩn bị được ảnh minh họa cho chế độ dự phòng.', detail: error.message });
  }
});

router.post('/uploads/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ ok: false, error: 'Chưa nhận được hình ảnh.' });
    const mimeType = String(req.file.mimetype || '').toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mimeType)) {
      return res.status(415).json({
        ok: false,
        error: 'Định dạng ảnh này cần được trình duyệt chuyển đổi trước khi tải lên. Hãy dùng PNG, JPG, WEBP hoặc GIF.'
      });
    }
    const dataUrl = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;
    res.set('Cache-Control', 'no-store').json({ ok: true, mimeType, dataUrl, passthrough: true });
  } catch (error) {
    console.error('[POST /api/uploads/image]', error);
    res.status(400).json({ ok: false, error: 'Không xử lý được hình ảnh.', detail: error.message });
  }
});

router.post('/reports/status', async (req, res) => {
  try {
    const folderUrl = safeText(req.body?.folderUrl, 2000).trim();
    const baseName = safeFilePart(req.body?.baseName);
    const submissionId = safeText(req.body?.submissionId, 160).trim();
    if (!folderUrl || !baseName || !submissionId) {
      return res.status(400).json({ ok: false, error: 'Thiếu dữ liệu kiểm tra bài nộp.' });
    }
    const result = await gas.postJson({
      action: 'findSubmission',
      folderUrl,
      baseName,
      submissionId
    }, { timeoutMs: 18000, retries: 1 });
    res.set('Cache-Control', 'no-store').json({ ok: true, ...result });
  } catch (error) {
    console.error('[POST /api/reports/status]', error);
    res.status(502).json({ ok: false, found: false, error: 'Không kiểm tra được trạng thái bài nộp.', detail: error.message });
  }
});

router.post('/reports/submit', async (_req, res) => {
  // Vercel-safe mode intentionally avoids Puppeteer/Chromium/Sharp in the
  // main Express function. The browser renderer is the primary path.
  return res.status(503).set('Cache-Control', 'no-store').json({
    ok: false,
    code: 'CLIENT_RENDER_REQUIRED',
    fallbackRequired: true,
    error: 'Renderer máy chủ đã được tắt trên Vercel để tăng độ ổn định. Hãy dùng renderer trên thiết bị.'
  });
});

// Client-side report fallback: if Chromium is unavailable, the browser creates a
// PNG with html2canvas and uploads only the final compressed PNG here.
router.post('/reports/upload', fallbackReportUpload.single('report'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ ok: false, error: 'Chưa nhận được file báo cáo PNG.' });
    const folderUrl = safeText(req.body?.folderUrl, 2000).trim();
    const baseName = safeFilePart(req.body?.baseName);
    if (!folderUrl || !baseName) return res.status(400).json({ ok: false, error: 'Thiếu Folder hoặc tên bài nộp.' });

    const submissionId = safeText(req.body?.submissionId, 160).trim();
    const preferredAttempt = Math.max(1, Number.parseInt(req.body?.localAttempt, 10) || 1);
    const png = req.file.buffer;
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png.length < 8 || !png.subarray(0, 8).equals(pngSignature)) {
      return res.status(400).json({ ok: false, error: 'File báo cáo không phải PNG hợp lệ.' });
    }

    // Client đã giới hạn kích thước PNG trước khi upload. Không chạy Sharp lại
    // ở fast path để giảm đáng kể thời gian CPU trên Vercel/local server.
    const result = await uploadPngToDrive({ png, folderUrl, baseName, submissionId, preferredAttempt });
    res.json({ ok: true, mode: 'drive', ...result });
  } catch (error) {
    console.error('[POST /api/reports/upload]', error);
    res.status(502).json({ ok: false, error: 'Không tải được báo cáo fallback lên Google Drive.', detail: error.message });
  }
});

module.exports = router;
