import express from 'express';
import { body, param } from 'express-validator';
import { protect } from '../middleware/authMiddleware.js';
import { listNotifications, updateNotification } from '../controllers/notificationController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
router.get('/', asyncHandler(protect), asyncHandler(listNotifications));
router.patch('/:id', asyncHandler(protect), [param('id').isMongoId(), body('status').isIn(['Open', 'In_Progress', 'Resolved', 'Dismissed']), handleValidation], asyncHandler(updateNotification));
export default router;
