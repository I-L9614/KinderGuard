import express from 'express';
import { body, param } from 'express-validator';
import { refreshToken, logout, stepUp, getSessionsForUser, revokeSession } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { loginLimiter } from './userRoutes.js';

const router = express.Router();

router.post('/refresh', asyncHandler(refreshToken));
router.post('/logout', asyncHandler(logout));
router.post('/step-up', loginLimiter, asyncHandler(protect), [body('password').isString(), body('action').isString().trim().isLength({ min: 1, max: 100 }), body('scope').optional().isString().trim().isLength({ max: 100 }), handleValidation], asyncHandler(stepUp));

router.get('/sessions', asyncHandler(protect), asyncHandler(getSessionsForUser));
router.delete('/sessions/:id', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(revokeSession));

export default router;
