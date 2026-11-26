import mongoose from 'mongoose';

// One-time password reset tokens. Only the sha256 of the token is stored, so
// a database dump cannot reset accounts. ONE document per account: issuing a
// token atomically replaces the previous hash, so two live links can never
// exist, even under concurrent requests. A successful reset marks the token
// used before the password changes, so a token can never be replayed.
const passwordResetTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  tokenHash: { type: String, required: true, index: true },
  requestedFromIp: { type: String },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  // Flood control: how many reset emails this account got in the current hour.
  sendWindowStart: { type: Date },
  sendCount: { type: Number, default: 0 },
}, { timestamps: true });

// Hygiene only: remove expired token documents. Correctness is enforced by
// the explicit expiresAt/usedAt checks at claim time.
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PasswordResetToken', passwordResetTokenSchema);
