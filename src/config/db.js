import mongoose from 'mongoose';
import { verifyNameKeyIndex, settleModelInit, verifyAuthorityNameKeyIndex } from '../utils/nameKeyIndex.js';

// Idempotent index migration for databases created before v0.3.5: they carry a
// unique, NON-sparse index on refreshtokens.token. Since 0.3.5 stores only the
// token hash (the token field is absent on new docs), that stale index rejects
// every refresh-token insert after the first one with E11000, which surfaces
// to users as 'רשומה עם הפרטים האלה כבר קיימת.' on login. Mongoose never
// alters an existing index, so repair the shape here on boot: drop the stale
// form and recreate it unique+sparse. Safe to run on every start - it only
// acts when the stale shape is found, and it never touches documents.
export const ensureRefreshTokenIndexShape = async (connection = mongoose.connection) => {
  try {
    const collection = connection.db.collection('refreshtokens');
    const indexes = await collection.indexes();
    const stale = indexes.find((index) => index.name === 'token_1' && index.unique && !index.sparse);
    if (!stale) return false;
    await collection.dropIndex('token_1');
    await collection.createIndex({ token: 1 }, { unique: true, sparse: true, name: 'token_1', background: true });
    console.log('Migrated refreshtokens token_1 index to unique+sparse (legacy plaintext-token index shape)');
    return true;
  } catch (error) {
    // A migration hiccup must never block server startup; log without secrets.
    const text = String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/gi, '[MongoDB URI redacted]');
    console.error('refreshtokens index migration failed:', text);
    return false;
  }
};



const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  const conn = await mongoose.connect(uri);

  console.log(`MongoDB connected: ${conn.connection.host}`);
  await ensureRefreshTokenIndexShape(conn.connection);
  // Readiness proof for name uniqueness: User.init() resolves after the
  // autoIndex build finishes, so this verification observes the real index,
  // not a hoped-for one. Missing or wrong shape: name creation/rename fails
  // closed (see utils/nameKeyIndex.js) until the approved repair script runs;
  // logins are unaffected.
  const { default: User } = await import('../models/User.js');
  await settleModelInit(User);
  if (!(await verifyNameKeyIndex(conn.connection))) {
    console.error('users nameKey_1 index missing or wrong shape: name creation/rename refuses until scripts/ensureNameKeyIndex.mjs runs. Logins unaffected.');
  }
  // Rollout visibility only (autoIndex is off for Authority by design): the
  // duplicate-name reconcile mode is deterministic with or without this
  // index, so nothing fails closed here - the log tells the operator whether
  // the approved migration script has run yet.
  if (!(await verifyAuthorityNameKeyIndex(conn.connection))) {
    console.log('authorities adminId_1_nameKey_1 index not present yet: duplicate-name protection is in reconcile mode until the approved scripts/migrate-authority-nameKey.js --apply runs.');
  }
  return conn;
};

export default connectDB;
