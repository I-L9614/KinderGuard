// One-off backfill (NOT run automatically). Usage: node scripts/backfill-agreement-names.js [--apply]
// Dry run by default: reports how many rent agreements are missing their
// denormalized branch/authority display names. With --apply it copies the
// current names from the Branch/Authority documents. Agreements whose branch
// or authority was already deleted are reported and skipped (nothing to copy
// from); their history fields stay empty until set manually.
import mongoose from 'mongoose';
import RentAgreement from '../src/models/RentAgreement.js';
import Branch from '../src/models/Branch.js';
import Authority from '../src/models/Authority.js';

const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGO_URI);
const agreements = await RentAgreement.find({ $or: [{ branchName: { $in: [null, ''] } }, { authorityName: { $in: [null, ''] } }] }).lean();
let orphaned = 0; let fillable = 0;
for (const a of agreements) {
  const [b, au] = await Promise.all([Branch.findById(a.branchId).select('name').lean(), Authority.findById(a.authorityId).select('name').lean()]);
  if (!b || !au) { orphaned++; console.log(`ORPHANED agreement=${a._id} branch=${b ? 'ok' : 'gone'} authority=${au ? 'ok' : 'gone'}`); continue; }
  fillable++;
  if (apply) await RentAgreement.updateOne({ _id: a._id }, { $set: { branchName: b.name || '', authorityName: au.name || '' } }, { timestamps: false });
}
console.log(`agreements missing names=${agreements.length} fillable=${fillable} orphaned=${orphaned} ${apply ? 'applied' : 'dry-run'}`);
await mongoose.disconnect();
