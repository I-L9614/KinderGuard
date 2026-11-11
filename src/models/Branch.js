import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  address: { type: String, trim: true },
  // daycare (default): a daycare branch with permits. property: a rented
  // asset such as an office - appears only in the rent module, never in the
  // permits branch list.
  kind: { type: String, enum: ['daycare', 'property'], default: 'daycare', index: true },
  maxChildren: { type: Number, min: 0 },
  managerName: { type: String, trim: true },
  phone: { type: String, trim: true },
  emails: { type: [String], default: [] },
  // The payer this branch's rent belongs to (council or private landlord).
  // Optional: set from the branch form or the payers import, used later by rent agreements.
  authorityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Authority', default: null },
  status: { type: String, enum: ['Active', 'Pending_License', 'Suspended'], default: 'Active' },
  deleting: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.model('Branch', branchSchema);
