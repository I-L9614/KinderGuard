import mongoose from 'mongoose';

// Durable evidence of a user-confirmed branch deletion operation. Exists from
// the moment the deletion guard is claimed until every permit of that branch
// (and its stored document) is confirmed gone. Recovery only ever touches
// branchIds recorded here - never arbitrary branchless data.
const branchDeletionSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true, index: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export default mongoose.model('BranchDeletion', branchDeletionSchema);
