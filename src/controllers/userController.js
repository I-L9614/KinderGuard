import User from '../models/User.js';
import Branch from '../models/Branch.js';
import LoginLockout from '../models/LoginLockout.js';
import logger from '../utils/logger.js';
import { getAdminId } from '../utils/access.js';
import { issueTokensForUser } from './authController.js';
import { maskEmail } from '../utils/passwordPolicy.js';
import { nameKey, nameTaken } from '../utils/nameKey.js';
import { verifyNameKeyIndex, settleModelInit } from '../utils/nameKeyIndex.js';

// Per-account lockout: after LOCKOUT_THRESHOLD consecutive failed logins the
// account is blocked for a full LOCKOUT_DURATION_MS, even for the correct
// password. A successful login before the threshold resets the count, and
// failures older than LOCKOUT_WINDOW_MS no longer count, so old history cannot
// lock an account later. Known tradeoff: someone who knows an email address
// can keep that account temporarily locked out; the block is time-boxed.
const LOCKOUT_THRESHOLD = Number(process.env.LOGIN_LOCKOUT_THRESHOLD) || 5;
const LOCKOUT_DURATION_MS = Number(process.env.LOGIN_LOCKOUT_DURATION_MS) || 60 * 60 * 1000;
const LOCKOUT_WINDOW_MS = Number(process.env.LOGIN_LOCKOUT_WINDOW_MS) || 60 * 60 * 1000;
const LOCKED_MESSAGE = 'החשבון נחסם לשעה בעקבות ניסיונות התחברות כושלים. נסו שוב בעוד כשעה.';

// One atomic aggregation-pipeline update per document: append the failure,
// prune entries older than the window, and set the lock exactly when the count
// crosses the threshold. Concurrent failures serialize at the database, so the
// count can neither skip the threshold nor clobber a parallel failure, and a
// failure landing while the account is already locked never extends the lock.
const recordFailedLogin = async (email, now) => {
  const windowStart = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
  const lockUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
  await LoginLockout.findOneAndUpdate(
    { email },
    [
      {
        $set: {
          failures: {
            $filter: {
              input: { $concatArrays: [{ $ifNull: ['$failures', []] }, [now]] },
              as: 'ts',
              cond: { $gte: ['$$ts', windowStart] },
            },
          },
        },
      },
      {
        $set: {
          lockedUntil: {
            $cond: [
              {
                $and: [
                  { $gte: [{ $size: '$failures' }, LOCKOUT_THRESHOLD] },
                  { $not: [{ $gt: ['$lockedUntil', now] }] },
                ],
              },
              lockUntil,
              '$lockedUntil',
            ],
          },
        },
      },
    ],
    { upsert: true }
  );
};

export const registerUser = async (req, res) => {
  // Public registration is only for the first account. Later users are added by an Admin.
  if (await User.exists({})) return res.status(403).json({ message: 'ההרשמה סגורה. בקשו ממנהל החשבון להוסיף אתכם.' });
  const { name, email, password } = req.body;
  const user = await User.create({ name, email, password, role: 'Admin' });
  user.adminId = user._id;
  await user.save();
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, token: await issueTokensForUser(res, user) });
};

export const createManagedUser = async (req, res) => {
  const { name, email, password, role = 'Manager', accessibleBranches = [], aiEnabled = false } = req.body;
  const ai = aiEnabled === true;
  if (!['Admin', 'Manager'].includes(role)) return res.status(400).json({ message: 'תפקיד משתמש לא תקין' });
  if (await User.exists({ email })) return res.status(400).json({ message: 'כתובת הדוא״ל כבר קיימת' });
  // Display names double as login identifiers, so they must be unique across
  // the whole system (login has no account picker). Normalized comparison:
  // extra spaces or different casing cannot sneak in a duplicate, and the
  // unique index on nameKey closes the race between this check and the write.
  // The application-level check alone loses a concurrent-create race; the
  // unique index is what closes it, so refuse while it is not provably there.
  await settleModelInit(User);
  if (!(await verifyNameKeyIndex())) return res.status(503).json({ message: 'המערכת משלימה תחזוקה רגעית. נסו שוב בעוד דקה.' });
  if (await nameTaken(User, name)) return res.status(400).json({ message: 'השם הזה כבר תפוס. בחרו שם אחר.' });

  const adminId = getAdminId(req.user);

  if (role === 'Admin') {
    // Co-admin: linked to the same account (adminId), so they see and manage the exact
    // same branches, licenses and rent data. Full access to every branch by role.
    const user = await User.create({ name, email, password, role: 'Admin', adminId, accessibleBranches: [], aiEnabled: ai });
    return res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
  }

  const branches = await Branch.find({ _id: { $in: accessibleBranches }, adminId });
  if (branches.length !== new Set(accessibleBranches.map(String)).size) {
    return res.status(400).json({ message: 'אחד או יותר מהסניפים שנבחרו אינם שייכים לחשבון' });
  }

  const user = await User.create({ name, email, password, role: 'Manager', adminId, accessibleBranches: branches.map((b) => b._id), aiEnabled: ai });
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, accessibleBranches: user.accessibleBranches });
};

export const listManagedUsers = async (req, res) => {
  const users = await User.find({ adminId: getAdminId(req.user), _id: { $ne: getAdminId(req.user) } }).select('name email role aiEnabled accessibleBranches createdAt').populate('accessibleBranches', 'name');
  res.json(users);
};

export const loginUser = async (req, res) => {
  const { password } = req.body;
  // Name-or-email login: newer clients send `identifier`; older installed
  // clients still send `email`. Anything with an @ is treated as an email,
  // everything else as a display name in canonical form (utils/nameKey).
  const rawIdentifier = String(req.body.identifier ?? req.body.email ?? '');
  const isEmail = rawIdentifier.includes('@');
  const normalizedIdentifier = isEmail ? rawIdentifier.trim().toLowerCase() : nameKey(rawIdentifier);
  if (!normalizedIdentifier) {
    return res.status(400).json({ message: 'נא להזין שם או כתובת דוא״ל' });
  }
  // The account is resolved before the lockout check so the lockout key
  // follows the ACCOUNT: typing the same person by name or by email shares
  // one counter, while an unknown identifier gets its own key.
  let user = isEmail
    ? await User.findOne({ email: normalizedIdentifier })
    : await User.findOne({ nameKey: normalizedIdentifier });
  if (!user && !isEmail) {
    // Accounts created before nameKey existed: match the stored name with the
    // same normalization, then backfill the key on the successful path below.
    const storedForm = rawIdentifier.normalize('NFC').trim().replace(/\s+/g, ' ');
    const matching = (await User.find({ name: storedForm })).filter((c) => nameKey(c.name) === normalizedIdentifier);
    // Two legacy accounts can share a name (the schema never enforced
    // uniqueness): never guess between them - email still works for both.
    if (matching.length > 1) {
      return res.status(400).json({ message: 'השם משויך ליותר מחשבון אחד. התחברו עם כתובת הדוא״ל.' });
    }
    if (matching.length === 1) user = matching[0];
  }
  const lockKey = user ? `user:${user._id}` : `id:${normalizedIdentifier}`;
  const now = new Date();
  const lock = await LoginLockout.findOne({ email: lockKey }).lean();
  if (lock?.lockedUntil && lock.lockedUntil > now) {
    logger.warn('Blocked login attempt on locked account');
    return res.status(429).json({ message: LOCKED_MESSAGE });
  }
  if (!user || !(await user.comparePassword(password))) {
    logger.warn(`Failed login for identifier: ${isEmail ? maskEmail(normalizedIdentifier) : `${normalizedIdentifier.slice(0, 1)}***`}`);
    await recordFailedLogin(lockKey, now);
    return res.status(401).json({ message: 'פרטי ההתחברות שגויים' });
  }
  if (lock) await LoginLockout.updateOne({ email: lockKey }, { $set: { failures: [], lockedUntil: null } });
  if (!user.nameKey) {
    user.nameKey = nameKey(user.name);
    try { await user.save(); } catch (e) { /* a racing save set the same key */ logger.warn(`nameKey backfill skipped: ${e.message}`); }
  }
  res.json({ id: user._id, name: user.name, email: user.email, role: user.role, token: await issueTokensForUser(res, user) });
};

export const getCurrentUser = async (req, res) => {
  const user = req.user.toObject();
  user.adminId = getAdminId(req.user);
  res.json(user);
};
