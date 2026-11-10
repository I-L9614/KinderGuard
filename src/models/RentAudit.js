import mongoose from 'mongoose';

// Append-only audit trail for record corrections. Records the before/after
// state of every payment edit and grouped-payment cancellation. Nothing here
// is ever updated or deleted: the original values survive every correction.
const rentAuditSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: ['edit_payment', 'cancel_group', 'revert_payment', 'revert_group'], required: true, index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentPayment', default: null },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentPaymentGroup', default: null },
    branchName: { type: String, default: '' },
    authorityName: { type: String, default: '' },
    reason: { type: String, default: '' },
    before: { type: mongoose.Schema.Types.Mixed, required: true },
    after: { type: mongoose.Schema.Types.Mixed, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export default mongoose.model('RentAudit', rentAuditSchema);
