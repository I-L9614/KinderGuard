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
  // Denormalized display names captured at creation: history (closed
  // agreements, lists) keeps rendering after a branch or authority is
  // deleted, when the populated refs go null.
  branchName: { type: String, default: '' },
  authorityName: { type: String, default: '' },
  // incoming: the authority pays rent for a daycare (the original case).
  // outgoing: the account pays rent to the authority (e.g. office landlords).
  direction: { type: String, enum: ['incoming', 'outgoing'], default: 'outgoing', index: true },
  // Amounts may be absent until the user supplies them: null means "not set
  // yet", never zero and never paid. No payments are scheduled while null.
  monthlyAmount: { type: Number, min: 0, default: null },
  // Editable figure for one quarterly payment. Defaults to monthlyAmount x 3
  // in the controller, but stays an independent stored value so an agreed
  // quarterly sum is entered directly instead of drifting on monthly x 3.
  quarterlyAmount: { type: Number, min: 0, default: null },
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
  status: { type: String, enum: ['Active', 'Closed', 'Pending_Setup'], default: 'Active', index: true },
  closedAt: { type: Date, default: null },
  // A guarded (AI-path) create starts as Pending_Setup + pendingGuard: rows in
  // that state are invisible to every consumer that filters status:'Active'
  // (reports, counts, AI lists, reminders, schedulers, groups) and have no
  // payments yet. The commit point flips them to Active and clears the flag
  // atomically BEFORE the schedule is materialized; success is gated on that
  // commit. A row still flagged never returned success - a crash or a failed
  // unwind - so the startup/hourly reconcile removes it with any children
  // (reconcileGuardedAgreementCreates). Plain-UI creates never set either.
  pendingGuard: { type: Boolean, default: false },
  // Set by the reconcile sweep when it claims a stale pending row: the claim
  // unsets pendingGuard atomically, so a writer resuming after the age
  // threshold finds its commit condition unmatched instead of activating a
  // row whose children are being deleted. A crash after the claim leaves
  // this flag so the next pass resumes cleanup.
  sweepClaim: { type: Boolean, default: false },
  // Rent documents (contracts, approvals from the authority, payment
  // confirmations). Kept fully separate from license/approval documents:
  // different prefix in storage, different routes, admin-only access.
  documents: {
    type: [{
      key: { type: String, required: true },
      fileName: { type: String, default: '' },
      // sha256 of the stored bytes, recorded for files saved through the AI worker. Older and manually uploaded files have none.
      sha256: { type: String, default: '' },
      uploadedAt: { type: Date, default: Date.now },
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    }],
    default: [],
  },
}, { timestamps: true, optimisticConcurrency: true });

export default mongoose.model('RentAgreement', rentAgreementSchema);
