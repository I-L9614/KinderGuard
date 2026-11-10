import mongoose from 'mongoose';

const licenseTypeSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  // null means the type is available to every branch in this account.
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

licenseTypeSchema.index({ adminId: 1, branchId: 1, name: 1 }, { unique: true });
export default mongoose.model('LicenseType', licenseTypeSchema);
