// One-off migration (NOT run automatically). Usage: node scripts/migrate-authority-nameKey.js [--apply]
// Dry run by default: backfills nothing, lists duplicate normalized names per admin. With --apply it sets nameKey
// on records whose name is unique for that admin, skips (and reports) duplicates, then builds the partial unique index.
import mongoose from 'mongoose';
import Authority from '../src/models/Authority.js';
import { normName } from '../src/utils/normName.js';

const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGO_URI);
const all = await Authority.find({}).select('adminId name nameKey').lean();
const groups = new Map();
for (const a of all) { const k = `${a.adminId}|${normName(a.name)}`; groups.set(k, [...(groups.get(k) || []), a]); }
const dups = [...groups.values()].filter((g) => g.length > 1);
console.log(`authorities=${all.length} duplicate groups=${dups.length}`);
for (const g of dups) console.log('DUPLICATE', g.map((x) => `${x._id}:${x.name}`).join(' | '));
if (apply) {
  let n = 0;
  for (const g of groups.values()) if (g.length === 1 && !g[0].nameKey) { await Authority.updateOne({ _id: g[0]._id }, { $set: { nameKey: normName(g[0].name) } }, { timestamps: false }); n++; }
  await Authority.createIndexes();
  console.log(`backfilled=${n}; index built`);
}
await mongoose.disconnect();
