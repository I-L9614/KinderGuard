import mongoose from 'mongoose';

const licenseSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  licenseTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LicenseType', required: true, index: true },
  issueDate: { type: Date, required: true },
  expiryDate: { type: Date, required: true, index: true },
  fileUrl: { type: String, default: '' },
  fileName: { type: String, default: '' },
  pendingFileDeletion: { type: String, default: '' },
  status: { type: String, enum: ['Valid', 'Expiring_Soon', 'Expired'], default: 'Valid', index: true },
  lifecycle: { type: String, enum: ['Active', 'Replaced'], default: 'Active', index: true },
  replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'License', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

licenseSchema.index({ branchId: 1, licenseTypeId: 1, lifecycle: 1 });
licenseSchema.index({ branchId: 1, licenseTypeId: 1 }, { unique: true, partialFilterExpression: { lifecycle: 'Active' } });
export default mongoose.model('License', licenseSchema);
