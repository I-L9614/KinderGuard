import express from 'express';
import { body, param } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { getLicenseTypes, createLicenseType, deactivateLicenseType } from '../controllers/licenseTypeController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
router.get('/', asyncHandler(protect), asyncHandler(getLicenseTypes));
router.post('/', asyncHandler(protect), authorizeRoles('Admin'), [body('name').trim().notEmpty().isLength({ max: 100 }), body('description').optional().isString(), body('branchId').optional({ nullable: true }).isMongoId(), handleValidation], asyncHandler(createLicenseType));
router.delete('/:id', asyncHandler(protect), authorizeRoles('Admin'), [param('id').isMongoId(), handleValidation], asyncHandler(deactivateLicenseType));
export default router;
