import mongoose from 'mongoose';

// One short-lived, single-use grant proving the user just re-entered their
// password for one specific sensitive action. The AI assistant and the
// browser carry only the signed token; raw passwords never travel with the
// action itself.
const stepUpGrantSchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  // Optional exact target of the action (for AI confirms: the proposal id).
  // When set, requireStepUp only consumes the grant for that very target, so
  // a refunded or stolen token can never be pointed at a different proposal.
  scope: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { timestamps: true });

stepUpGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export default mongoose.model('StepUpGrant', stepUpGrantSchema);
