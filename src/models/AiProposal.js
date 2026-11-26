import mongoose from 'mongoose';

// Server-held AI proposal and its audit trail. The browser only ever sends the id,
// so a tampered or replayed proposal body is impossible; the document is the record
// of who asked, what was proposed, who confirmed, and what happened.
const aiProposalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['action', 'license_fill'], default: 'action' },
  fileSha256: { type: String, default: '' },
  final: { type: mongoose.Schema.Types.Mixed, default: null },
  action: { type: mongoose.Schema.Types.Mixed, required: true },
  promptExcerpt: { type: String, default: '', maxlength: 300 },
  status: { type: String, enum: ['pending', 'executing', 'done'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  confirmedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

export default mongoose.models.AiProposal || mongoose.model('AiProposal', aiProposalSchema);

// One row per failed step-up password attempt; expires on its own. Counted per user across all proposals.
const stepUpFailSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, at: { type: Date, default: Date.now, expires: 3600 } });
export const StepUpFail = mongoose.models.AiStepUpFail || mongoose.model('AiStepUpFail', stepUpFailSchema);
