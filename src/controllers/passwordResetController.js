import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import PasswordResetToken from '../models/PasswordResetToken.js';
import RefreshToken from '../models/RefreshToken.js';
import LoginLockout from '../models/LoginLockout.js';
import { nameKey } from '../utils/nameKey.js';
import { sendPasswordResetEmail } from '../utils/resetMailer.js';
import logger from '../utils/logger.js';
import { maskEmail } from '../utils/passwordPolicy.js';

const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 30;
const RESET_MAX_PER_HOUR = Number(process.env.PASSWORD_RESET_MAX_PER_HOUR) || 3;

// The same words whether or not the account exists, so this endpoint cannot
// be used to discover which names or emails are registered.
const GENERIC_MESSAGE = 'אם הפרטים תואמים חשבון קיים, נשלח אליו קישור לאיפוס הסיסמה.';
const INVALID_LINK_MESSAGE = 'הקישור לא תקף או שפג תוקפו. בקשו קישור חדש.';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Reset links are built ONLY from the configured public origin. Falling back
// to the request Host header would let an attacker poison emailed links by
// sending a forged Host with the victim's identifier, so a missing or invalid
// APP_PUBLIC_URL fails closed: no token is issued and nothing is sent.
const trustedBaseUrl = () => {
  const raw = String(process.env.APP_PUBLIC_URL || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

export const forgotPassword = async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  // Answer first, work after: the response and its timing are identical for
  // existing and unknown accounts (non-enumeration). Failures after this
  // point are logged, never surfaced.
  res.json({ message: GENERIC_MESSAGE });
  if (!identifier) return;
  try {
    const base = trustedBaseUrl();
    if (!base) {
      logger.error('Password reset skipped: APP_PUBLIC_URL is not configured - refusing to build reset links from the request host');
      return;
    }
    const user = identifier.includes('@')
      ? await User.findOne({ email: identifier.toLowerCase() })
      : await User.findOne({ nameKey: nameKey(identifier) });
    if (!user) return;
    // Per-account flood control on top of the per-IP limiter. The gate runs
    // BEFORE the token is replaced, so a flooded account's outstanding link
    // stays alive. Concurrent requests can overrun the counter slightly; the
    // token invariant below is unaffected.
    const existing = await PasswordResetToken.findOne({ user: user._id });
    const now = new Date();
    const inWindow = existing?.sendWindowStart && now.getTime() - existing.sendWindowStart.getTime() < 60 * 60 * 1000;
    const sent = inWindow ? existing.sendCount || 0 : 0;
    if (sent >= RESET_MAX_PER_HOUR) {
      logger.warn(`Password reset flood control: email skipped for ${maskEmail(user.email)}`);
      return;
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    // One document per account: this atomic replace IS the invalidation. The
    // previous hash stops existing the instant this write lands, so two live
    // links are impossible even under concurrent requests.
    await PasswordResetToken.findOneAndUpdate(
      { user: user._id },
      {
        $set: {
          tokenHash: sha256(rawToken),
          requestedFromIp: req.ip,
          expiresAt: new Date(now.getTime() + RESET_TTL_MINUTES * 60 * 1000),
          usedAt: null,
          sendWindowStart: inWindow ? existing.sendWindowStart : now,
          sendCount: sent + 1,
        },
      },
      { upsert: true },
    );
    await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl: `${base}/#reset=${rawToken}`, ttlMinutes: RESET_TTL_MINUTES });
    logger.info(`Password reset email sent for ${maskEmail(user.email)}`);
  } catch (error) {
    logger.error(`Password reset request failed: ${error.message}`);
  }
};

export const resetPassword = async (req, res) => {
  const { token, password } = req.body;
  // Atomic claim: only the first valid presentation marks the token used, so
  // it cannot be replayed, even by concurrent requests. Once claimed, no
  // failure path below can make it usable again.
  const claimed = await PasswordResetToken.findOneAndUpdate(
    { tokenHash: sha256(String(token)), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return res.status(400).json({ message: INVALID_LINK_MESSAGE });
  const user = await User.findById(claimed.user);
  if (!user) return res.status(400).json({ message: INVALID_LINK_MESSAGE });
  const version = user.authVersion || 0;
  const revokeAllSessions = () => RefreshToken.updateMany({ user: user._id, revoked: false }, { $set: { revoked: true } });
  // Revocation sweep BEFORE the password write: if the write then fails, the
  // account keeps its old password but loses its sessions - fail safe. The
  // sweep AFTER the write catches any refresh rotation that raced the first
  // one; a pre-reset token presented later trips the refresh reuse detector,
  // which revokes everything again.
  await revokeAllSessions();
  // Generation-bound write: the password, its audit timestamp and the auth
  // version commit ONLY if no other password flow landed since this one
  // claimed its link. A newer reset (or a newer issuance that completed)
  // bumped authVersion, this update matches nothing, and the stale flow is
  // refused instead of overwriting the newer password.
  const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));
  const committed = await User.updateOne(
    { _id: user._id, authVersion: version },
    { $set: { password: hashed, authVersion: version + 1, passwordChangedAt: new Date() } },
  );
  if (committed.matchedCount === 0) return res.status(400).json({ message: INVALID_LINK_MESSAGE });
  await revokeAllSessions();
  // Clear any login lockout so the owner can sign in straight away.
  await LoginLockout.deleteMany({ email: { $in: [`user:${user._id}`, `id:${user.email}`, `id:${nameKey(user.name)}`] } });
  logger.info(`Password reset completed for ${maskEmail(user.email)}`);
  res.json({ message: 'הסיסמה עודכנה. התחברו עם הסיסמה החדשה.' });
};
