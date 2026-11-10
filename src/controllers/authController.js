import crypto from 'crypto';
import RefreshToken from '../models/RefreshToken.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

const REFRESH_TOKEN_TTL_MS = parseInt(process.env.REFRESH_TOKEN_TTL_MS || String(30 * 24 * 60 * 60 * 1000), 10);
const REFRESH_TOKEN_LIMIT = parseInt(process.env.REFRESH_TOKEN_LIMIT || '5', 10);

const createRefreshToken = async (userId, opts = {}) => {
  const token = crypto.randomBytes(48).toString('hex');
  const jti = crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const doc = await RefreshToken.create({
    jti,
    token,
    user: userId,
    ip: opts.ip,
    userAgent: opts.userAgent,
    expiresAt,
  });

  // enforce limit of active tokens per user
  const activeTokens = await RefreshToken.find({ user: userId, revoked: false }).sort({ createdAt: -1 });
  if (activeTokens.length > REFRESH_TOKEN_LIMIT) {
    const tokensToRevoke = activeTokens.slice(REFRESH_TOKEN_LIMIT);
    const ids = tokensToRevoke.map((t) => t._id);
    await RefreshToken.updateMany({ _id: { $in: ids } }, { revoked: true });
  }

  return doc;
};

const generateAccessToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '1h' });
};

export const refreshToken = async (req, res) => {
  const incoming = req.cookies?.refreshToken || req.body.refreshToken;
  if (!incoming) {
    return res.status(401).json({ message: 'פג תוקף החיבור. התחברו שוב.' });
  }
  const tokenDoc = await RefreshToken.findOne({ token: incoming });
  if (!tokenDoc || tokenDoc.revoked || tokenDoc.expiresAt < new Date()) {
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
  tokenDoc.replacedByToken = newRefresh.token;
  await tokenDoc.save();

  // set rotated cookie
  res.cookie('refreshToken', newRefresh.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });

  const accessToken = generateAccessToken(user._id);
  return res.json({ token: accessToken });
};

export const logout = async (req, res) => {
  const incoming = req.cookies?.refreshToken || req.body.refreshToken;
  if (!incoming) {
    return res.status(204).send();
  }
  const doc = await RefreshToken.findOne({ token: incoming });
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
  const accessToken = generateAccessToken(user._id);
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
