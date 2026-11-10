import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License', required: true, index: true },
  triggerDays: { type: Number, enum: [30, 7, 0], required: true },
  status: { type: String, enum: ['Open', 'In_Progress', 'Resolved', 'Dismissed'], default: 'Open', index: true },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

notificationSchema.index({ licenseId: 1, triggerDays: 1 }, { unique: true });
export default mongoose.model('Notification', notificationSchema);
