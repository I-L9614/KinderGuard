import mongoose from 'mongoose';

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
  return conn;
};

export default connectDB;
