import mongoose from 'mongoose';

const RefreshTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true, index: true },
  // Legacy plaintext value. Tokens created after the hashing change store only
  // tokenHash; this field stays so pre-change sessions keep working until they
  // age out (REFRESH_TOKEN_TTL_MS), then it can be dropped.
  token: { type: String, required: false, unique: true, sparse: true },
  // sha256 of the bearer token. The raw token never touches the database, so a
  // leaked dump does not hand out live sessions.
  tokenHash: { type: String, required: false, unique: true, sparse: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ip: { type: String },
  userAgent: { type: String },
  replacedByToken: { type: String },
  revoked: { type: Boolean, default: false },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

export default mongoose.model('RefreshToken', RefreshTokenSchema);
