import express from 'express';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { importPayersBranches } from '../controllers/importController.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
// Owner-supplied bulk import: admin-only, like every other write.
router.post('/payers-branches', asyncHandler(protect), authorizeRoles('Admin'), asyncHandler(importPayersBranches));
export default router;
