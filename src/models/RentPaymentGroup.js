import mongoose from 'mongoose';

const allocationSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentPayment', required: true },
    agreementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentAgreement', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    branchName: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

// One physical payment (a single cheque or bank transfer) made to an authority,
// allocated across several daycares with a distinct amount per daycare.
// totalAmount always equals the sum of allocations. The group's lifecycle
// (Pending -> Handed -> Cleared) is propagated onto the linked RentPayment
// rows, so per-branch and per-authority actual-paid reports derived from the
// payments can never double count: each shekel lives on exactly one payment.
const rentPaymentGroupSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Authority', required: true, index: true },
    authorityName: { type: String, required: true, trim: true },
    method: { type: String, enum: ['cheque', 'transfer'], required: true },
    totalAmount: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: ['Pending', 'Handed', 'Cleared', 'Cancelled'], default: 'Pending', index: true },
    handedAt: { type: Date, default: null },
    clearedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    note: { type: String, default: '' },
    allocations: { type: [allocationSchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model('RentPaymentGroup', rentPaymentGroupSchema);
