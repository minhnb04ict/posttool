const multer = require('multer');

const maxMb = Math.max(1, Number(process.env.MAX_IMAGE_UPLOAD_MB || 15));

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxMb * 1024 * 1024,
    files: 1
  },
  fileFilter(_req, file, cb) {
    if (!String(file.mimetype || '').startsWith('image/')) {
      return cb(new Error('Chỉ chấp nhận tệp hình ảnh.'));
    }
    cb(null, true);
  }
});
