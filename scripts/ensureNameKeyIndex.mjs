// Explicit, human-approved repair for the users nameKey unique+sparse index.
// Runs only when an operator chooses to: node scripts/ensureNameKeyIndex.mjs
// Fails loudly on duplicate names (Mongo refuses the unique build) and never
// touches documents. A wrong-shaped existing index is only replaced with the
// explicit --replace-wrong-shape flag.
import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is required');
  process.exit(1);
}
await mongoose.connect(uri);
const collection = mongoose.connection.db.collection('users');
const indexes = await collection.indexes();
const existing = indexes.find((i) => i.name === 'nameKey_1');
if (existing && existing.unique && existing.sparse) {
  console.log('nameKey_1 already unique+sparse; nothing to do');
  process.exit(0);
}
if (existing && !process.argv.includes('--replace-wrong-shape')) {
  console.error(`nameKey_1 exists with the wrong shape (${JSON.stringify({ unique: existing.unique, sparse: existing.sparse })}). Re-run with --replace-wrong-shape to drop and recreate it.`);
  process.exit(1);
}
if (existing) await collection.dropIndex('nameKey_1');
try {
  await collection.createIndex({ nameKey: 1 }, { unique: true, sparse: true, name: 'nameKey_1', background: true });
  console.log('nameKey_1 created unique+sparse');
} catch (e) {
  console.error(`Index build refused by MongoDB: ${e.message}`);
  console.error('Most likely duplicate display names exist. Resolve them by hand (no automatic renaming), then re-run.');
  process.exit(1);
}
await mongoose.disconnect();
