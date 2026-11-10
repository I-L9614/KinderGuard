import mongoose from 'mongoose';

// One scheduled rent payment for one daycare under one authority. One payment
// belongs to exactly one branch, so per-authority totals are plain sums with
// no double counting. branchName/authorityName are denormalized so payment
// history survives branch or authority removal.
const rentPaymentSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  agreementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentAgreement', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  authorityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Authority', required: true },
  branchName: { type: String, default: '' },
  authorityName: { type: String, default: '' },
  dueDate: { type: Date, required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  method: { type: String, enum: ['cheque', 'transfer'], required: true },
  // Pending: scheduled, nothing handed over. Handed: cheque deposited with the
  // authority, money has NOT left the account. Cleared: money actually moved.
  // Cancelled: future payment of a closed agreement. Transfers never use Handed.
  status: { type: String, enum: ['Pending', 'Handed', 'Cleared', 'Cancelled'], default: 'Pending', index: true },
  // Set when this payment is one allocation of a grouped physical payment
  // (one cheque / transfer covering several daycares). Status transitions then
  // happen only through the group, so group and payments never diverge.
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentPaymentGroup', default: null },
  paidAt: { type: Date, default: null },
  clearedAt: { type: Date, default: null },
}, { timestamps: true });

// Schedule materialization is idempotent: one row per agreement per due date.
rentPaymentSchema.index({ agreementId: 1, dueDate: 1 }, { unique: true });

export default mongoose.model('RentPayment', rentPaymentSchema);
