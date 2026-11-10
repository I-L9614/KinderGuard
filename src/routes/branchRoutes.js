import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { createBranch, getBranches, deleteBranch } from '../controllers/branchController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
router.get('/', asyncHandler(protect), asyncHandler(getBranches));
router.post('/', asyncHandler(protect), authorizeRoles('Admin'), [body('name').trim().notEmpty(), body('address').optional().isString(), handleValidation], asyncHandler(createBranch));
router.delete('/:id', asyncHandler(protect), authorizeRoles('Admin'), asyncHandler(deleteBranch));
export default router;
