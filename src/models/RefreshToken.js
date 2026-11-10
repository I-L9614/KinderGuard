import mongoose from 'mongoose';

const RefreshTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true, index: true },
  token: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ip: { type: String },
  userAgent: { type: String },
  replacedByToken: { type: String },
  revoked: { type: Boolean, default: false },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

export default mongoose.model('RefreshToken', RefreshTokenSchema);
