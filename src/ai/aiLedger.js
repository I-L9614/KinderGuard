import { randomUUID } from 'crypto';
import AiUsage, { AiReservation } from '../models/AiUsage.js';
import { AI_MSG } from './claudeClient.js';

// One document holds lifetime spend, today's date and today's call count, so a
// reservation is ONE conditional atomic update: it passes only if spend plus the
// reservation stays within budgetUsd AND today's calls are under the limit. A
// day rollover resets the counter inside the same update. There is no second
// write to roll back, so a crash or a concurrent request cannot leave a call
// slot taken without spend (or spend without a slot).
// A failed or timed-out model call keeps its reservation (it can still be
// billed), so retries are always counted. settle() corrects to the real cost.
const KEY = 'ledger';

export const createMongoLedger = ({ budgetUsd, dailyCallLimit, now = () => new Date() }) => ({
  async reserve(estUsd) {
    const today = now().toISOString().slice(0, 10);
    await AiUsage.updateOne({ key: KEY }, { $setOnInsert: { key: KEY, spentUsd: 0, calls: 0, day: '' } }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; });
    const sameDay = { $eq: ['$day', today] };
    const updated = await AiUsage.findOneAndUpdate(
      { key: KEY, $expr: { $and: [
        { $lte: [{ $add: ['$spentUsd', estUsd] }, budgetUsd] },
        { $or: [{ $ne: ['$day', today] }, { $lt: ['$calls', dailyCallLimit] }] },
      ] } },
      [{ $set: {
        spentUsd: { $add: ['$spentUsd', estUsd] },
        calls: { $cond: [sameDay, { $add: ['$calls', 1] }, 1] },
        day: today,
      } }],
    );
    if (updated) {
      const reservationId = randomUUID();
      await AiReservation.create({ reservationId, estUsd });
      return { reservationId, estUsd };
    }
    // Refused: say which limit, for a useful message. Nothing was changed.
    const cur = await AiUsage.findOne({ key: KEY });
    if (cur && cur.spentUsd + estUsd > budgetUsd) throw Object.assign(new Error(AI_MSG.budget), { statusCode: 429 });
    throw Object.assign(new Error(AI_MSG.daily), { statusCode: 429 });
  },
  // Idempotent: only the first settle of a reservation id changes spend.
  async settle(reservation, actualUsd) {
    const rec = await AiReservation.findOneAndUpdate({ reservationId: reservation.reservationId, settled: false }, { $set: { settled: true } });
    if (!rec) return false;
    await AiUsage.updateOne({ key: KEY }, { $inc: { spentUsd: actualUsd - rec.estUsd } });
    return true;
  },
  async spent() { return (await AiUsage.findOne({ key: KEY }))?.spentUsd || 0; },
});
