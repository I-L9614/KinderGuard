import mongoose from 'mongoose';

// Readiness proof for the users nameKey unique+sparse index. Name uniqueness
// is a hard requirement: the application-level nameTaken checks cannot close
// a concurrent-create race on their own, so name creation/rename must fail
// closed while this index is missing or the wrong shape. Read-only: never
// creates, drops or alters anything. Repaired only via the explicitly
// approved scripts/ensureNameKeyIndex.mjs. Logins never consult this.
export const verifyNameKeyIndex = async (connection = mongoose.connection) => {
  try {
    const indexes = await connection.db.collection('users').indexes();
    const idx = indexes.find((i) => i.name === 'nameKey_1');
    return Boolean(idx && idx.unique && idx.sparse);
  } catch {
    return false;
  }
};

// Read-only shape check for the authorities (adminId, nameKey) partial unique
// index. The index is built only by the explicitly approved
// scripts/migrate-authority-nameKey.js --apply (autoIndex is off for the
// model). Until then duplicate-name protection runs in reconcile mode (see
// createAuthority), which is deterministic on its own, so this check gates
// nothing - it reports rollout readiness only.
export const verifyAuthorityNameKeyIndex = async (connection = mongoose.connection) => {
  try {
    const indexes = await connection.db.collection('authorities').indexes();
    const idx = indexes.find((i) => i.name === 'adminId_1_nameKey_1');
    return Boolean(idx && idx.unique && idx.partialFilterExpression && idx.partialFilterExpression.nameKey);
  } catch {
    return false;
  }
};

// Model.init() rejects when the autoIndex build itself fails (for example a
// duplicate key blocking the unique build). That rejection must never take
// down server boot or surface as a raw 500: settle it here and let the
// read-only shape check decide readiness. When the build failed, the shape
// check finds no healthy index and name writes refuse with 503; when the
// index is actually fine, writes proceed and the unique index still closes
// the race.
export const settleModelInit = async (model) => {
  try {
    await model.init();
  } catch {
    /* readiness is decided by verifyNameKeyIndex below */
  }
};
