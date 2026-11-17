import multer from 'multer';
import { ALLOWED_UPLOAD_MIME } from '../utils/uploadTypes.js';

// Shared server-side type gate for uploaded documents (the browser's accept=
// is only a hint): permits and rent documents are PDFs or common images.
// Anything else is rejected before it reaches storage, so a malicious file can
// never be served back from our origin later.
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME.has(file.mimetype)) return cb(null, true);
    const error = new Error('ניתן להעלות רק קובץ PDF או תמונה (JPEG, PNG, WebP).');
    error.statusCode = 400;
    error.publicMessage = error.message;
    return cb(error);
  },
});
