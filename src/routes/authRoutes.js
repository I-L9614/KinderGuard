import express from 'express';
import { param } from 'express-validator';
import { refreshToken, logout, getSessionsForUser, revokeSession } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();

router.post('/refresh', asyncHandler(refreshToken));
router.post('/logout', asyncHandler(logout));

router.get('/sessions', asyncHandler(protect), asyncHandler(getSessionsForUser));
router.delete('/sessions/:id', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(revokeSession));

export default router;
