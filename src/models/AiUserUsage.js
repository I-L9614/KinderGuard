import mongoose from 'mongoose';

// Best-effort per-user VIEW of how many times a user's request reached the model client, per day. It is NOT billing and NOT a limit:
// the global atomic ledger (AiUsage) is the only enforced cap. An attempt the global cap refused is counted too, a failed write here
// is skipped (logged), and there is no unique index, so a rare race can split one day into two documents that the report sums.
const aiUserUsageSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  day: { type: String, required: true },
  attempts: { type: Number, default: 0 },
}, { versionKey: false });

export default mongoose.models.AiUserUsage || mongoose.model('AiUserUsage', aiUserUsageSchema);
