import mongoose from 'mongoose';

const authoritySchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
}, { timestamps: true });

export default mongoose.model('Authority', authoritySchema);
