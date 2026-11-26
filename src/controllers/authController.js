import crypto from 'crypto';
import { issueStepUpGrant } from '../utils/stepUp.js';
import RefreshToken from '../models/RefreshToken.js';
import StepUpFail from '../models/StepUpFail.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const REFRESH_TOKEN_TTL_MS = parseInt(process.env.REFRESH_TOKEN_TTL_MS || String(30 * 24 * 60 * 60 * 1000), 10);
const REFRESH_TOKEN_LIMIT = parseInt(process.env.REFRESH_TOKEN_LIMIT || '5', 10);
// Grace window that separates a legitimate concurrent-refresh race from a
// replayed stolen token; see the refresh handler below.
const REUSE_GRACE_MS = parseInt(process.env.REFRESH_REUSE_GRACE_MS || '30000', 10);

const createRefreshToken = async (userId, opts = {}) => {
  const token = crypto.randomBytes(48).toString('hex');
  const jti = crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const doc = await RefreshToken.create({
    jti,
    tokenHash: hashToken(token),
    user: userId,
    ip: opts.ip,
    userAgent: opts.userAgent,
    expiresAt,
  });
  // The raw token is returned to the caller exactly once (cookie/replacement
  // chain) and is never persisted - only its hash is stored.
  doc.token = token;

  // enforce limit of active tokens per user
  const activeTokens = await RefreshToken.find({ user: userId, revoked: false }).sort({ createdAt: -1 });
  if (activeTokens.length > REFRESH_TOKEN_LIMIT) {
    const tokensToRevoke = activeTokens.slice(REFRESH_TOKEN_LIMIT);
    const ids = tokensToRevoke.map((t) => t._id);
    await RefreshToken.updateMany({ _id: { $in: ids } }, { revoked: true });
  }

  return doc;
};

// The access JWT carries the user's auth version (av). A password reset
// increments the version atomically with the password write, and protect
// rejects any token whose av is stale - so a reset kills live access tokens
// immediately, with no reliance on clock comparison.
const generateAccessToken = (user) => {
  return jwt.sign({ id: user._id, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '1h' });
};

export const refreshToken = async (req, res) => {
  const incoming = req.cookies?.refreshToken || req.body.refreshToken;
  if (!incoming) {
    return res.status(401).json({ message: 'פג תוקף החיבור. התחברו שוב.' });
  }
  // Hash lookup first; the plaintext fallback keeps sessions issued before
  // the hashing change valid until they age out, so deploys force no re-login.
  const tokenDoc = await RefreshToken.findOne({ tokenHash: hashToken(incoming) })
    || await RefreshToken.findOne({ token: incoming });
  if (!tokenDoc || tokenDoc.expiresAt < new Date()) {
    return res.status(401).json({ message: 'פג תוקף החיבור. התחברו שוב.' });
  }
  // A revoked token presented again is either a race (two near-simultaneous
  // refreshes from clients sharing one cookie jar) or a replay of a stolen
  // token. Within REUSE_GRACE_MS of the revocation we assume a race and only
  // reject; past it we assume theft and revoke every active session of the
  // user, forcing a fresh sign-in on all devices. Expired-only tokens are
  // never treated as replay (handled above).
  if (tokenDoc.revoked) {
    const revokedForMs = Date.now() - new Date(tokenDoc.updatedAt).getTime();
    if (revokedForMs > REUSE_GRACE_MS) {
      await RefreshToken.updateMany({ user: tokenDoc.user, revoked: false }, { revoked: true });
    }
    return res.status(401).json({ message: 'פג תוקף החיבור. התחברו שוב.' });
  }

  const user = await User.findById(tokenDoc.user);
  if (!user) {
    return res.status(401).json({ message: 'המשתמש אינו קיים עוד. התחברו מחדש.' });
  }

  // rotate: revoke current, issue a new refresh token
  // revoke current and record replacement
  tokenDoc.revoked = true;
  const newRefresh = await createRefreshToken(user._id, { ip: req.ip, userAgent: req.get('User-Agent') });
  tokenDoc.replacedByToken = newRefresh.tokenHash;
  await tokenDoc.save();

  // set rotated cookie
  res.cookie('refreshToken', newRefresh.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });

  const accessToken = generateAccessToken(user);
  return res.json({ token: accessToken });
};

// Step-up for sensitive actions (AI-triggered deletes, role changes, ...):
// the client re-checks the password here and receives a short-lived,
// single-use, action-scoped token; the action endpoint verifies it via
// requireStepUp. Passwords never ride along with the action itself.
// Wrong-password attempts are bounded twice: the route's loginLimiter per IP,
// and this per-user counter so rotating IPs cannot keep guessing against one
// account. STEPUP_WINDOW is implicit in the StepUpFail TTL (~15 minutes); a
// successful step-up clears the count.
const STEPUP_MAX_FAILURES = parseInt(process.env.STEPUP_MAX_FAILURES || '5', 10);
export const stepUp = async (req, res) => {
  const { password, action, scope } = req.body;
  const failures = await StepUpFail.countDocuments({ userId: req.user._id });
  if (failures >= STEPUP_MAX_FAILURES) {
    return res.status(429).json({ message: 'יותר מדי ניסיונות. המתינו כמה דקות ונסו שוב.' });
  }
  // req.user is password-stripped by protect; fetch the full record to check.
  const user = await User.findById(req.user._id);
  if (!(await user.comparePassword(String(password || '')))) {
    await StepUpFail.create({ userId: req.user._id });
    return res.status(401).json({ message: 'סיסמה שגויה.' });
  }
  await StepUpFail.deleteMany({ userId: req.user._id });
  const { token, expiresIn } = await issueStepUpGrant(user, String(action), scope);
  res.json({ stepUpToken: token, expiresIn });
};

export const logout = async (req, res) => {
  const incoming = req.cookies?.refreshToken || req.body.refreshToken;
  if (!incoming) {
    return res.status(204).send();
  }
  const doc = await RefreshToken.findOne({ tokenHash: hashToken(incoming) })
    || await RefreshToken.findOne({ token: incoming });
  if (doc) {
    doc.revoked = true;
    if (req.user) {
      doc.revokedBy = req.user._id;
    }
    await doc.save();
  }
  res.clearCookie('refreshToken', { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  logger.info('User logged out and refresh token revoked');
  return res.status(204).send();
};

export const issueTokensForUser = async (res, user) => {
  const accessToken = generateAccessToken(user);
  const refreshDoc = await createRefreshToken(user._id);
  // set httpOnly cookie with secure attributes
  res.cookie('refreshToken', refreshDoc.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
  return accessToken;
};

export const getSessionsForUser = async (req, res) => {
  const userId = req.user._id;
  const tokens = await RefreshToken.find({ user: userId }).sort({ createdAt: -1 });
  const out = tokens.map((t) => ({ id: t._id, jti: t.jti, createdAt: t.createdAt, expiresAt: t.expiresAt, revoked: t.revoked, ip: t.ip, userAgent: t.userAgent, replacedByToken: t.replacedByToken }));
  res.json(out);
};

export const revokeSession = async (req, res) => {
  const userId = req.user._id;
  const tokenId = req.params.id;
  const doc = await RefreshToken.findById(tokenId);
  if (!doc) return res.status(404).json({ message: 'ההתחברות המבוקשת לא נמצאה.' });
  if (String(doc.user) !== String(userId)) return res.status(403).json({ message: 'אין לכם הרשאה לבצע את הפעולה הזו.' });
  doc.revoked = true;
  doc.revokedBy = userId;
  await doc.save();
  res.status(204).send();
};

export const cleanupExpiredRefreshTokens = async () => {
  try {
    const result = await RefreshToken.deleteMany({ expiresAt: { $lt: new Date() } });
    logger.info(`Cleaned up ${result.deletedCount || 0} expired refresh tokens`);
  } catch (err) {
    logger.error(`Error cleaning refresh tokens: ${err.message}`);
  }
};
