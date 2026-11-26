// Canonical form of a display name, used for name-or-email login and for
// global name uniqueness: Unicode NFC, trimmed, inner whitespace collapsed to
// single spaces, lowercased (a no-op for Hebrew, relevant for Latin names).
// Login and user creation run the same function, so "איתמר  לוי" and
// "איתמר לוי" resolve to the same account and a stray space cannot mint a
// lookalike name.
export const nameKey = (name) => String(name || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

// Uniqueness check across BOTH migrated and pre-migration accounts: docs
// written before nameKey existed have no indexed key, so a plain nameKey
// lookup would miss them between deploy and backfill. Their names are
// compared here in canonical form; the user table is tiny (single account
// plus a handful of managed users), so the scan is cheap.
export const nameTaken = async (User, name, excludeId = null) => {
  const key = nameKey(name);
  if (!key) return false;
  const indexed = await User.exists({ nameKey: key, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  if (indexed) return true;
  const legacy = await User.find({ $or: [{ nameKey: { $exists: false } }, { nameKey: null }, { nameKey: '' }] }).select('name').lean();
  return legacy.some((u) => (!excludeId || String(u._id) !== String(excludeId)) && nameKey(u.name) === key);
};
