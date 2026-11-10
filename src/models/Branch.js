import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  address: { type: String, trim: true },
  maxChildren: { type: Number, min: 0 },
  status: { type: String, enum: ['Active', 'Pending_License', 'Suspended'], default: 'Active' },
  deleting: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.model('Branch', branchSchema);
