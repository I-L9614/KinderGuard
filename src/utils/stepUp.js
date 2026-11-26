import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import StepUpGrant from '../models/StepUpGrant.js';

const TTL_MS = 5 * 60 * 1000;
const INVALID_MESSAGE = 'הפעולה דורשת אימות נוסף. אשרו עם הסיסמה ונסו שוב.';

// Issue a 5-minute, single-use, action-scoped step-up grant after the server
// has verified the user's credentials. When TOTP enrollment ships, the
// issuing endpoint will also demand the current code for enrolled users;
// this contract (token in, X-Step-Up header out) does not change.
export const issueStepUpGrant = async (user, action, scope = '') => {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await StepUpGrant.create({ jti, user: user._id, action, scope: String(scope || ''), expiresAt });
  const token = jwt.sign({}, process.env.JWT_SECRET, { subject: String(user._id), jwtid: jti, expiresIn: TTL_MS / 1000 });
  return { token, expiresIn: TTL_MS / 1000 };
};

// Middleware factory: require a valid, unused step-up grant for this action
// on mutating methods, and consume it atomically so it cannot be replayed.
export const requireStepUp = (action, getScope) => async (req, res, next) => {
  try {
    const token = String(req.headers['x-step-up'] || '');
    const payload = jwt.verify(token, process.env.JWT_SECRET, { subject: String(req.user._id) });
    const filter = { jti: payload.jti, user: req.user._id, action, usedAt: null, expiresAt: { $gt: new Date() } };
    // A grant issued for one exact target (e.g. proposal id) opens only that
    // target; grants without a scope only open scope-less endpoints.
    if (getScope) filter.scope = String(getScope(req) || '');
    const grant = await StepUpGrant.findOneAndUpdate(
      filter,
      { $set: { usedAt: new Date() } },
      { new: true },
    );
    if (!grant) return res.status(403).json({ message: INVALID_MESSAGE });
    next();
  } catch {
    return res.status(403).json({ message: INVALID_MESSAGE });
  }
};

// Best-effort refund for the AI confirm route: when a request consumed a grant
// but never reached a successful execution (the proposal expired in the race
// before the claim, or the stored change no longer applies), restore the grant
// so the user is not asked for the password again on the immediate retry.
// Single-use is preserved: the success path never refunds, so one grant still
// authorizes at most one completed action.
export const refundStepUpGrant = async (req) => {
  try {
    const payload = jwt.decode(String(req.headers['x-step-up'] || ''));
    if (!payload?.jti) return;
    await StepUpGrant.updateOne(
      { jti: payload.jti, user: req.user._id, usedAt: { $ne: null }, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: null } },
    );
  } catch { /* best effort: the grant simply expires */ }
};
