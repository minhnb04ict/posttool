const multer = require('multer');

function envMegabytesToIntegerBytes(value, fallbackMb = 3, minMb = 1, maxMb = 20) {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  const mb = Number.isFinite(parsed) && parsed > 0
    ? Math.min(maxMb, Math.max(minMb, parsed))
    : fallbackMb;

  // Multer 2.x validates this strictly and rejects fractional byte values.
  return Math.max(1, Math.floor(mb * 1024 * 1024));
}

const maxUploadBytes = envMegabytesToIntegerBytes(process.env.MAX_IMAGE_UPLOAD_MB, 3);

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes,
    files: 1
  },
  fileFilter(_req, file, cb) {
    if (!String(file.mimetype || '').startsWith('image/')) {
      return cb(new Error('Chỉ chấp nhận tệp hình ảnh.'));
    }
    cb(null, true);
  }
});

module.exports.maxUploadBytes = maxUploadBytes;
module.exports.envMegabytesToIntegerBytes = envMegabytesToIntegerBytes;
