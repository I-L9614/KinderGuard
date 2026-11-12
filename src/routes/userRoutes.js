import express from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { loginUser, registerUser, getCurrentUser, createManagedUser, listManagedUsers } from '../controllers/userController.js';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();

// Credential endpoints get a much tighter limit than the global one: password
// guessing needs volume, and 10 tries per 15 minutes per IP leaves normal
// sign-ins untouched. Max is env-overridable so tests can shrink it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ message: 'יותר מדי ניסיונות התחברות. המתינו כמה דקות ונסו שוב.' }),
});

// Per-account lockout lives in the login controller (see userController and
// models/LoginLockout): 5 consecutive failed logins block the account for a
// full hour, a successful login resets the count. It is DB-backed so it is
// shared across instances and survives restarts, unlike a memory limiter.
router.post('/login', loginLimiter, [body('email').isEmail(), body('password').isLength({ min: 6 }), handleValidation], asyncHandler(loginUser));
router.post('/register', loginLimiter, [body('name').trim().notEmpty(), body('email').isEmail(), body('password').isLength({ min: 8 }), handleValidation], asyncHandler(registerUser));
router.get('/me', asyncHandler(protect), asyncHandler(getCurrentUser));
router.get('/', asyncHandler(protect), authorizeRoles('Admin'), asyncHandler(listManagedUsers));
router.post('/', asyncHandler(protect), authorizeRoles('Admin'), [body('name').trim().notEmpty(), body('email').isEmail(), body('password').isLength({ min: 8 }), body('role').optional().isIn(['Admin', 'Manager']), body('accessibleBranches').optional().isArray(), handleValidation], asyncHandler(createManagedUser));
export default router;
