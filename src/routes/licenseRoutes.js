import express from 'express';
import { body, param } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { createLicense, getLicenses, getLicenseHistory, downloadLicenseFile, deleteLicense, deleteLicenseFile } from '../controllers/licenseController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { documentUpload } from '../middleware/upload.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { licenseProposalGuard } from '../ai/licenseProposalGuard.js';

const router = express.Router();
router.get('/', asyncHandler(protect), asyncHandler(getLicenses));
router.get('/:id/file', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(downloadLicenseFile));
router.get('/:id/history', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(getLicenseHistory));
router.post('/', asyncHandler(protect), authorizeRoles('Manager', 'Admin'), documentUpload.single('file'), asyncHandler(licenseProposalGuard), [
  body('branchId').isMongoId(), body('licenseTypeId').isMongoId(), body('issueDate').isISO8601(), body('expiryDate').isISO8601(), handleValidation,
], asyncHandler(createLicense));
router.delete('/:id/file', asyncHandler(protect), authorizeRoles('Manager', 'Admin'), [param('id').isMongoId(), handleValidation], asyncHandler(deleteLicenseFile));
router.delete('/:id', asyncHandler(protect), authorizeRoles('Admin'), [param('id').isMongoId(), handleValidation], asyncHandler(deleteLicense));
export default router;
