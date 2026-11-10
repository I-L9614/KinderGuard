import express from 'express';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import {
  listAuthorities, createAuthority, deleteAuthority,
  createAgreement, updateAgreement, closeAgreement,
  markPaymentHanded, markPaymentCleared, rentSummary,
  listPaymentGroups, createPaymentGroup, markGroupHanded, markGroupCleared, getPaidReport, editPayment, cancelPaymentGroup,
} from '../controllers/rentController.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();
// Financial data is admin-only in this version.
router.use(asyncHandler(protect), authorizeRoles('Admin'));
router.get('/summary', asyncHandler(rentSummary));
router.get('/authorities', asyncHandler(listAuthorities));
router.post('/authorities', asyncHandler(createAuthority));
router.delete('/authorities/:id', asyncHandler(deleteAuthority));
router.post('/agreements', asyncHandler(createAgreement));
router.patch('/agreements/:id', asyncHandler(updateAgreement));
router.post('/agreements/:id/close', asyncHandler(closeAgreement));
router.get('/payment-groups', asyncHandler(listPaymentGroups));
router.post('/payment-groups', asyncHandler(createPaymentGroup));
router.post('/payment-groups/:id/handed', asyncHandler(markGroupHanded));
router.post('/payment-groups/:id/cleared', asyncHandler(markGroupCleared));
router.get('/reports/paid', asyncHandler(getPaidReport));
router.patch('/payments/:id', asyncHandler(editPayment));
router.post('/payment-groups/:id/cancel', asyncHandler(cancelPaymentGroup));
router.post('/payments/:id/handed', asyncHandler(markPaymentHanded));
router.post('/payments/:id/cleared', asyncHandler(markPaymentCleared));
export default router;
