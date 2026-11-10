import express from 'express';
import { body, param, query } from 'express-validator';
import { protect } from '../middleware/authMiddleware.js';
import { listTasks, createTask, updateTask, deleteTask } from '../controllers/taskController.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
const statuses = ['To_Do', 'In_Progress', 'Done'];

router.get('/', asyncHandler(protect), [query('scope').optional().isIn(['all']), query('status').optional().isIn(statuses), handleValidation], asyncHandler(listTasks));
router.post('/', asyncHandler(protect), [
  body('title').isString().trim().isLength({ min: 1, max: 200 }),
  body('notes').optional().isString().isLength({ max: 2000 }),
  body('dueDate').optional({ nullable: true }).isISO8601(),
  body('branchId').optional({ nullable: true }).isMongoId(),
  handleValidation,
], asyncHandler(createTask));
router.patch('/:id', asyncHandler(protect), [
  param('id').isMongoId(),
  body('title').optional().isString().trim().isLength({ min: 1, max: 200 }),
  body('notes').optional().isString().isLength({ max: 2000 }),
  body('status').optional().isIn(statuses),
  body('dueDate').optional({ nullable: true }).isISO8601(),
  body('branchId').optional({ nullable: true }).isMongoId(),
  handleValidation,
], asyncHandler(updateTask));
router.delete('/:id', asyncHandler(protect), [param('id').isMongoId(), handleValidation], asyncHandler(deleteTask));

export default router;
