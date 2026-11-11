import mongoose from 'mongoose';

// A rent agreement between one branch (daycare) or property (office) and one
// authority (council, private payer, or landlord). The due schedule
// (frequency) is separate from the cheque handover schedule: cheques may be
// deposited with the authority in advance while each one is debited on its
// own scheduled date.
const rentAgreementSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  authorityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Authority', required: true, index: true },
  // incoming: the authority pays rent for a daycare (the original case).
  // outgoing: the account pays rent to the authority (e.g. office landlords).
  direction: { type: String, enum: ['incoming', 'outgoing'], default: 'incoming', index: true },
  // Amounts may be absent until the user supplies them: null means "not set
  // yet", never zero and never paid. No payments are scheduled while null.
  monthlyAmount: { type: Number, min: 0, default: null },
  // Editable figure shown as the agreement's yearly total. Defaults to
  // monthlyAmount x 12 in the controller, but stays an independent stored
  // value so partial-year or variable agreements are not forced into x12.
  annualAmount: { type: Number, min: 0, default: null },
  // Schedule fields stay null while there is no amount; they become
  // required-by-validation once an amount is set.
  frequency: { type: String, enum: ['monthly', 'quarterly', 'annual', 'custom', null], default: null },
  firstDueDate: { type: Date, default: null },
  customDueDates: { type: [Date], default: [] },
  paymentMethod: { type: String, enum: ['cheque', 'transfer', null], default: null },
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
