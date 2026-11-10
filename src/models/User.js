import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['Admin', 'Manager'], required: true, default: 'Manager' },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  accessibleBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
}, { timestamps: true });

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.pre('save', async function () {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, await bcrypt.genSalt(10));
  }
});

export default mongoose.model('User', userSchema);
