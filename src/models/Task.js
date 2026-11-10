import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  status: { type: String, enum: ['To_Do', 'In_Progress', 'Done'], default: 'To_Do', index: true },
  dueDate: { type: Date, default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('Task', taskSchema);
