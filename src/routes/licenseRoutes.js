import express from 'express';
import multer from 'multer';
import { body, param } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { createLicense, getLicenses, getLicenseHistory, deleteLicense } from '../controllers/licenseController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.get('/', asyncHandler(protect), asyncHandler(getLicenses));
router.get('/:id/history', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(getLicenseHistory));
router.post('/', asyncHandler(protect), authorizeRoles('Manager', 'Admin'), upload.single('file'), [
  body('branchId').isMongoId(), body('licenseTypeId').isMongoId(), body('issueDate').isISO8601(), body('expiryDate').isISO8601(), handleValidation,
], asyncHandler(createLicense));
router.delete('/:id', asyncHandler(protect), authorizeRoles('Admin'), [param('id').isMongoId(), handleValidation], asyncHandler(deleteLicense));
export default router;
