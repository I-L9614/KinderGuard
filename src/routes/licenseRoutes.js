import express from 'express';
import multer from 'multer';
import { body, param } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { createLicense, getLicenses, getLicenseHistory, downloadLicenseFile, deleteLicense } from '../controllers/licenseController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { ALLOWED_UPLOAD_MIME } from '../utils/uploadTypes.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();

// Server-side type gate (the browser's accept= is only a hint): permits are
// PDFs or common images. Anything else is rejected before it reaches storage,
// so a malicious file can never be served back from our origin later.
const upload = multer({
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
router.get('/', asyncHandler(protect), asyncHandler(getLicenses));
router.get('/:id/file', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(downloadLicenseFile));
router.get('/:id/history', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(getLicenseHistory));
router.post('/', asyncHandler(protect), authorizeRoles('Manager', 'Admin'), upload.single('file'), [
  body('branchId').isMongoId(), body('licenseTypeId').isMongoId(), body('issueDate').isISO8601(), body('expiryDate').isISO8601(), handleValidation,
], asyncHandler(createLicense));
router.delete('/:id', asyncHandler(protect), authorizeRoles('Admin'), [param('id').isMongoId(), handleValidation], asyncHandler(deleteLicense));
export default router;
