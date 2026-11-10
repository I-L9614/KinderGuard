import express from 'express';
import { body } from 'express-validator';
import { loginUser, registerUser, getCurrentUser, createManagedUser, listManagedUsers } from '../controllers/userController.js';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
router.post('/login', [body('email').isEmail(), body('password').isLength({ min: 6 }), handleValidation], asyncHandler(loginUser));
router.post('/register', [body('name').trim().notEmpty(), body('email').isEmail(), body('password').isLength({ min: 8 }), handleValidation], asyncHandler(registerUser));
router.get('/me', asyncHandler(protect), asyncHandler(getCurrentUser));
router.get('/', asyncHandler(protect), authorizeRoles('Admin'), asyncHandler(listManagedUsers));
router.post('/', asyncHandler(protect), authorizeRoles('Admin'), [body('name').trim().notEmpty(), body('email').isEmail(), body('password').isLength({ min: 8 }), body('role').optional().isIn(['Admin', 'Manager']), body('accessibleBranches').optional().isArray(), handleValidation], asyncHandler(createManagedUser));
export default router;
