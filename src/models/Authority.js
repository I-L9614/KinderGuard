import mongoose from 'mongoose';

const authoritySchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  // council: municipality / regional council / municipal company.
  // private: a private landlord or organization the rent is paid to.
  type: { type: String, enum: ['council', 'private'], default: 'council' },
  // Normalized name key. New records carry it; legacy records without it are covered by the read check only.
  nameKey: { type: String },
  // Two-phase delete guard (same pattern as Branch): claimed atomically
  // before the active-agreement check so agreement creation can refuse or
  // unwind against it and two deletes cannot interleave. A stale guard from
  // a crashed delete is released by reconcileAuthorityDeleteGuards.
  deleting: { type: Boolean, default: false },
}, { timestamps: true, autoIndex: false });
// autoIndex is OFF for this model on purpose: the index below is built only by scripts/migrate-authority-nameKey.js (an approved migration step), never silently at deploy.
// Partial unique index: enforces no duplicate (normalized) name per admin for records that carry a nameKey, and cannot fail on legacy data.
authoritySchema.index({ adminId: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { nameKey: { $type: 'string' } } });

export default mongoose.model('Authority', authoritySchema);
