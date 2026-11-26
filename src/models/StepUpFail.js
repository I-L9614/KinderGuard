import mongoose from 'mongoose';

// One row per failed step-up password attempt, per user. The TTL index keeps
// only roughly the last 15 minutes (Mongo sweeps expired docs about once a
// minute), so countDocuments is the sliding-window count and cleanup is
// automatic. This is the per-user counterpart of the IP-based loginLimiter on
// the route: password guessing through step-up must stay bounded even when
// the guesses arrive from rotating IPs behind a hijacked session token.
const stepUpFailSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  at: { type: Date, default: Date.now, expires: 900 },
});

export default mongoose.models.StepUpFail || mongoose.model('StepUpFail', stepUpFailSchema);
