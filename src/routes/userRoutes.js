import express from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { loginUser, registerUser, getCurrentUser, createManagedUser, listManagedUsers } from '../controllers/userController.js';
import { forgotPassword, resetPassword } from '../controllers/passwordResetController.js';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { passwordPolicyError, PASSWORD_POLICY_MESSAGE } from '../utils/passwordPolicy.js';

const router = express.Router();

// Credential endpoints get a much tighter limit than the global one: password
// guessing needs volume, and 10 tries per 15 minutes per IP leaves normal
// sign-ins untouched. Max is env-overridable so tests can shrink it.
export const loginLimiter = rateLimit({
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
// Login takes the display name OR the email: `identifier` from current
// clients, `email` from older installed clients; at least one is required.
router.post('/login', loginLimiter, [
  body('identifier').optional().isString().trim().isLength({ min: 1, max: 200 }),
  body('email').optional().isEmail(),
  body('password').isLength({ min: 6 }),
  body().custom((b) => Boolean(b && (b.identifier || b.email))).withMessage('נא להזין שם או כתובת דוא״ל'),
  handleValidation,
], asyncHandler(loginUser));
// Password reset: own tight limiter, separate from login. The account that
// owns the email is the only one told anything; the requester always gets the
// same generic answer. Max is a function so tests can shrink it after startup.
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Number(process.env.RESET_RATE_LIMIT_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ message: 'יותר מדי בקשות איפוס סיסמה. המתינו כמה דקות ונסו שוב.' }),
});
router.post('/password/forgot', passwordResetLimiter, [body('identifier').isString().trim().isLength({ min: 1, max: 200 }), handleValidation], asyncHandler(forgotPassword));
router.post('/password/reset', passwordResetLimiter, [
  body('token').isString().isLength({ min: 32, max: 128 }),
  body('password').custom((pw) => !passwordPolicyError(pw)).withMessage(PASSWORD_POLICY_MESSAGE),
  handleValidation,
], asyncHandler(resetPassword));
router.post('/register', loginLimiter, [body('name').trim().notEmpty(), body('email').isEmail(), body('password').custom((pw) => !passwordPolicyError(pw)).withMessage(PASSWORD_POLICY_MESSAGE), handleValidation], asyncHandler(registerUser));
router.get('/me', asyncHandler(protect), asyncHandler(getCurrentUser));
router.get('/', asyncHandler(protect), authorizeRoles('Admin'), asyncHandler(listManagedUsers));
router.post('/', asyncHandler(protect), authorizeRoles('Admin'), [body('name').trim().notEmpty(), body('email').isEmail(), body('password').custom((pw) => !passwordPolicyError(pw)).withMessage(PASSWORD_POLICY_MESSAGE), body('role').optional().isIn(['Admin', 'Manager']), body('accessibleBranches').optional().isArray(), body('aiEnabled').optional().isBoolean(), handleValidation], asyncHandler(createManagedUser));
export default router;
