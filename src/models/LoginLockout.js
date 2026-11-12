import mongoose from 'mongoose';

// Per-account login lockout state. One document per normalized email.
// failures holds the timestamps of consecutive failed attempts (a successful
// login clears it); lockedUntil is set once the threshold is reached and the
// account is blocked - even for the correct password - until that time passes.
// Stored in MongoDB so the state is shared by every running instance (hosted
// and embedded servers use the same database) and survives restarts.
const loginLockoutSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  failures: { type: [Date], default: [] },
  lockedUntil: { type: Date, default: null },
});

// Hygiene only: drop lock documents once the lock has long expired. Correctness
// never depends on this - all reads compare timestamps explicitly.
loginLockoutSchema.index(
  { lockedUntil: 1 },
  { expireAfterSeconds: 3600, partialFilterExpression: { lockedUntil: { $type: 'date' } } }
);

export default mongoose.model('LoginLockout', loginLockoutSchema);
