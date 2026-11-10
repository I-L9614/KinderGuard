import mongoose from 'mongoose';

// A rent agreement between one branch (daycare) and one authority (council).
// The due schedule (frequency) is separate from the cheque handover schedule:
// cheques may be deposited with the authority in advance while each one is
// debited on its own scheduled date.
const rentAgreementSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  authorityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Authority', required: true, index: true },
  monthlyAmount: { type: Number, required: true, min: 0 },
  // Editable figure shown as the agreement's yearly total. Defaults to
  // monthlyAmount x 12 in the controller, but stays an independent stored
  // value so partial-year or variable agreements are not forced into x12.
  annualAmount: { type: Number, required: true, min: 0 },
  frequency: { type: String, enum: ['monthly', 'quarterly', 'annual', 'custom'], required: true },
  firstDueDate: { type: Date, required: true },
  customDueDates: { type: [Date], default: [] },
  paymentMethod: { type: String, enum: ['cheque', 'transfer'], required: true },
  // Present only when a series of cheques was deposited in advance.
  chequeSeries: {
    depositedCount: { type: Number, min: 0 },
    seriesStartDate: { type: Date },
    seriesEndDate: { type: Date },
  },
  status: { type: String, enum: ['Active', 'Closed'], default: 'Active', index: true },
  closedAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('RentAgreement', rentAgreementSchema);
