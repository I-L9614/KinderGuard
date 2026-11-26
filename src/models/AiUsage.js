import mongoose from 'mongoose';

// Account-wide AI spend ledger. A single 'ledger' document holds lifetime spend in USD,
// today's date and today's call count, changed only by one atomic conditional
// update (see aiLedger.js), so concurrent requests and restarts cannot overshoot.
const aiUsageSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  spentUsd: { type: Number, default: 0 },
  calls: { type: Number, default: 0 },
  day: { type: String, default: '' },
}, { timestamps: true });

export default mongoose.models.AiUsage || mongoose.model('AiUsage', aiUsageSchema);

// One record per reservation so settling twice cannot credit the budget twice.
const reservationSchema = new mongoose.Schema({
  reservationId: { type: String, required: true, unique: true },
  estUsd: { type: Number, required: true },
  settled: { type: Boolean, default: false },
}, { timestamps: true });
export const AiReservation = mongoose.models.AiReservation || mongoose.model('AiReservation', reservationSchema);
