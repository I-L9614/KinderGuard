import mongoose from 'mongoose';

// Durable record of every AI action the user CONFIRMED (done or refused at execution). AiProposal documents expire
// after 30 minutes, so they cannot serve as an audit. No secrets, no payloads: who, what kind, which target label, outcome.
// Deliberately no extra index and no TTL, so deploying this collection needs no index build.
const aiAuditSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  proposalId: { type: mongoose.Schema.Types.ObjectId },
  type: { type: String, required: true, maxlength: 60 },
  label: { type: String, default: '', maxlength: 200 },
  outcome: { type: String, enum: ['done', 'failed'], required: true },
  reason: { type: String, default: '', maxlength: 200 },
  at: { type: Date, default: Date.now },
}, { versionKey: false });

export default mongoose.models.AiAudit || mongoose.model('AiAudit', aiAuditSchema);
