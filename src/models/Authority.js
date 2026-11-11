import mongoose from 'mongoose';

const authoritySchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  // council: municipality / regional council / municipal company.
  // private: a private landlord or organization the rent is paid to.
  type: { type: String, enum: ['council', 'private'], default: 'council' },
}, { timestamps: true });

export default mongoose.model('Authority', authoritySchema);
