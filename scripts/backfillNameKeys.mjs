// One-off migration: backfill nameKey (utils/nameKey) for accounts created
// before name-or-email login existed. Safe to re-run. Fails loudly on a
// duplicate name instead of renaming anyone; resolve by hand and re-run.
// Usage: MONGO_URI=... node scripts/backfillNameKeys.mjs
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import { nameKey } from '../src/utils/nameKey.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is required');
  process.exit(1);
}

await mongoose.connect(uri);
const users = await User.find({ $or: [{ nameKey: { $exists: false } }, { nameKey: null }, { nameKey: '' }] });
const seen = new Map();
let updated = 0;
for (const user of users) {
  const key = nameKey(user.name);
  if (seen.has(key) || (await User.exists({ nameKey: key, _id: { $ne: user._id } }))) {
    console.error(`DUPLICATE NAME: "${user.name}" (${user._id}) collides with ${seen.get(key) || 'an existing account'} - resolve by hand, then re-run.`);
    process.exit(1);
  }
  seen.set(key, user._id);
  try {
    // Update only nameKey: no name modification, no document hooks, no
    // full-document validation of legacy accounts. The unique index (once
    // created) still guards this write at the storage level.
    await User.updateOne({ _id: user._id }, { $set: { nameKey: key } });
  } catch (e) {
    // A user created concurrently with the same name hits the unique index or
    // the pre-save guard here; fail loudly instead of renaming anyone.
    console.error(`FAILED to backfill "${user.name}" (${user._id}): ${e.message}`);
    process.exit(1);
  }
  updated += 1;
}
console.log(`nameKey backfill complete: ${updated} updated, ${users.length - updated} already fine`);
await mongoose.disconnect();
