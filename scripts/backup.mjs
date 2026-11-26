// Offline backup and restore for the KinderGuard MongoDB database.
//
// The Atlas free tier (M0) has no managed cloud backups, so this script is the
// documented safety net: it dumps every collection to one EJSON file per
// collection (ObjectIds and dates survive the round trip), and can restore a
// dump into a database. Restoring is always a deliberate manual act, never
// automatic, and should be rehearsed against a scratch database - never the
// live one.
//
// Usage:
//   node scripts/backup.mjs dump <outDir>     # reads MONGO_URI from the env
//   node scripts/backup.mjs restore <dumpDir> # restores into MONGO_URI's DB
import mongoose from 'mongoose';
// Use the driver's own BSON (via mongoose) so EJSON types always match the
// version that produced the documents.
const { EJSON } = mongoose.mongo.BSON;
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import path from 'path';

export const dumpTo = async (outDir) => {
  const db = mongoose.connection.db;
  await mkdir(outDir, { recursive: true });
  const collections = await db.listCollections().toArray();
  const summary = {};
  for (const { name } of collections) {
    if (name.startsWith('system.')) continue;
    const docs = await db.collection(name).find({}).toArray();
    await writeFile(path.join(outDir, `${name}.json`), EJSON.stringify(docs, null, 2));
    summary[name] = docs.length;
  }
  return summary;
};

export const restoreFrom = async (dir) => {
  const db = mongoose.connection.db;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const summary = {};
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const docs = EJSON.parse(await readFile(path.join(dir, file), 'utf8'));
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs);
    summary[name] = docs.length;
  }
  return summary;
};

const main = async () => {
  const [, , command, dir] = process.argv;
  if (!command || !dir || !['dump', 'restore'].includes(command)) {
    console.error('Usage: node scripts/backup.mjs <dump|restore> <dir>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const summary = command === 'dump' ? await dumpTo(dir) : await restoreFrom(dir);
  console.log(`${command} done:`, summary);
  await mongoose.disconnect();
};

if (process.argv[1] && process.argv[1].endsWith('backup.mjs')) await main();
