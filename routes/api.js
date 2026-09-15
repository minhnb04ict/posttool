const express = require('express');
const sharp = require('sharp');
const contentDisposition = require('content-disposition');
const upload = require('../middleware/imageUpload');
const gas = require('../services/googleAppsScript');
const { renderReportPng } = require('../services/reportRenderer');

const router = express.Router();

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

function safeDataImages(list, maxCount = 20) {
  return (Array.isArray(list) ? list : [])
    .slice(0, maxCount)
    .filter(item => typeof item === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(item));
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
    images: safeDataImages(answer?.images, 12)
  }));

  const illustrations = (Array.isArray(body.illustrations) ? body.illustrations : []).slice(0, 20)
    .map(item => ({
      dataUrl: typeof item?.dataUrl === 'string' && /^data:image\//i.test(item.dataUrl) ? item.dataUrl : '',
      alt: safeText(item?.alt, 180),
      caption: safeText(item?.caption, 180)
    }))
    .filter(item => item.dataUrl);

  const baseName = safeFilePart(body.baseName) || `${safeFilePart(studentClass)}_${safeFilePart(studentName)}_${safeFilePart(title)}`;

  return {
    studentName,
    studentClass,
    title,
    content,
    layout: normalizeLayout(body.layout),
    folderUrl: safeText(body.folderUrl, 2000).trim(),
    baseName,
    localAttempt: Math.max(1, Number.parseInt(body.localAttempt, 10) || 1),
    answers,
    illustrations
  };
}

router.get('/task', async (req, res) => {
  try {
    const upstream = await gas.getRaw(req.query);
    res.status(upstream.status)
      .set('Cache-Control', 'no-store, max-age=0')
      .type(upstream.contentType)
      .send(upstream.body);
  } catch (error) {
    console.error('[GET /api/task]', error);
    res.status(502).json({ ok: false, error: 'Không kết nối được Google Apps Script.', detail: error.message });
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

router.post('/uploads/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ ok: false, error: 'Chưa nhận được hình ảnh.' });
    const maxSide = Math.round(clamp(req.body?.maxSide, 600, 2600, 1800));
    const quality = Math.round(clamp(Number(req.body?.quality) * 100, 65, 95, 88));

    const result = await sharp(req.file.buffer, { limitInputPixels: 60_000_000 })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    res.set('Cache-Control', 'no-store').json({
      ok: true,
      mimeType: 'image/webp',
      width: result.info.width,
      height: result.info.height,
      dataUrl: `data:image/webp;base64,${result.data.toString('base64')}`
    });
  } catch (error) {
    console.error('[POST /api/uploads/image]', error);
    res.status(400).json({ ok: false, error: 'Không xử lý được hình ảnh.', detail: error.message });
  }
});

router.post('/reports/submit', async (req, res) => {
  let report;
  try {
    report = buildReportPayload(req.body || {});
    const png = await renderReportPng(report);

    if (report.folderUrl) {
      try {
        const result = await gas.postJson({
          action: 'uploadReport',
          folderUrl: report.folderUrl,
          baseName: report.baseName,
          imageData: `data:image/png;base64,${png.toString('base64')}`
        });
        return res.json({
          ok: true,
          mode: 'drive',
          fileName: result.fileName || '',
          fileId: result.fileId || '',
          fileUrl: result.fileUrl || ''
        });
      } catch (uploadError) {
        console.error('[Drive upload fallback]', uploadError);
        const fallbackName = `${report.baseName}_${report.localAttempt || 1}.png`;
        return res.status(200)
          .set('Cache-Control', 'no-store')
          .set('X-Posttool-Upload-Fallback', '1')
          .set('X-Report-Filename', encodeURIComponent(fallbackName))
          .set('Content-Disposition', contentDisposition(fallbackName))
          .type('png')
          .send(png);
      }
    }

    const fileName = `${report.baseName}_${report.localAttempt}.png`;
    return res.status(200)
      .set('Cache-Control', 'no-store')
      .set('X-Report-Filename', encodeURIComponent(fileName))
      .set('Content-Disposition', contentDisposition(fileName))
      .type('png')
      .send(png);
  } catch (error) {
    console.error('[POST /api/reports/submit]', error);
    res.status(500).json({ ok: false, error: 'Không tạo được ảnh báo cáo.', detail: error.message });
  }
});

module.exports = router;
