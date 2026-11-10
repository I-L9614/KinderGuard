import mongoose from 'mongoose';

// Rent reminders live in their own collection so the license-notification
// unique index ({licenseId, triggerDays}) stays untouched. The notifications
// API merges both kinds into one inbox for the alerts screen.
const rentReminderSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  branchName: { type: String, default: '' },
  rentAgreementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentAgreement', required: true, index: true },
  rentPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentPayment', default: null },
  rentTrigger: { type: String, enum: ['week_before_due', 'month_before_series_end'], required: true },
  dueDate: { type: Date, default: null },
  seriesEndDate: { type: Date, default: null },
  amount: { type: Number, default: null },
  method: { type: String, enum: ['cheque', 'transfer', null], default: null },
  status: { type: String, enum: ['Open', 'In_Progress', 'Resolved', 'Dismissed'], default: 'Open', index: true },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// One week-before reminder per payment; one series-end reminder per agreement
// per series end date (a renewed series with a new end date re-arms it).
rentReminderSchema.index(
  { rentPaymentId: 1, rentTrigger: 1 },
  { unique: true, partialFilterExpression: { rentPaymentId: { $type: 'objectId' } } },
);
rentReminderSchema.index(
  { rentAgreementId: 1, rentTrigger: 1, seriesEndDate: 1 },
  { unique: true, partialFilterExpression: { seriesEndDate: { $type: 'date' } } },
);

export default mongoose.model('RentReminder', rentReminderSchema);
