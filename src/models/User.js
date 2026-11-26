import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { nameKey, nameTaken } from '../utils/nameKey.js';
import { verifyNameKeyIndex, settleModelInit } from '../utils/nameKeyIndex.js';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Canonical display name (see utils/nameKey) for name-or-email login and for
  // global name uniqueness. Kept by the pre-save hook; sparse so accounts
  // created before this field existed simply lack it until their next save,
  // and the login path backfills them on first sign-in.
  nameKey: { type: String, unique: true, sparse: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['Admin', 'Manager'], required: true, default: 'Manager' },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  accessibleBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
  // AI worker access. Off by default; an admin sets it when creating a user.
  aiEnabled: { type: Boolean, default: false },
  // Bumped atomically with every password write (see passwordResetController).
  // Access JWTs carry the version they were issued under; protect rejects a
  // stale version, so a password reset kills live access tokens immediately.
  authVersion: { type: Number, default: 0 },
  // Audit only: when the password last changed. Authorization uses authVersion.
  passwordChangedAt: { type: Date },
}, { timestamps: true });

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.pre('save', async function () {
  if (this.isModified('name')) {
    this.nameKey = nameKey(this.name);
    // Backstop for every write path (creation endpoints pre-check too): a name
    // already taken by another account is refused here, and the unique index
    // on nameKey closes the remaining race.
    await settleModelInit(this.constructor);
    if (!(await verifyNameKeyIndex())) {
      const err = new Error('המערכת משלימה תחזוקה רגעית. נסו שוב בעוד דקה.');
      err.statusCode = 503;
      throw err;
    }
    const clash = await nameTaken(this.constructor, this.name, this._id);
    if (clash) {
      const err = new Error('השם הזה כבר תפוס. בחרו שם אחר.');
      err.statusCode = 400;
      throw err;
    }
  }
  if (this.isModified('password')) {
    this.passwordChangedAt = new Date();
    this.password = await bcrypt.hash(this.password, await bcrypt.genSalt(10));
  }
});

export default mongoose.model('User', userSchema);
