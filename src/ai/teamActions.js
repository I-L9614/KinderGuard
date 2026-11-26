import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';
import { createManagedUser } from '../controllers/userController.js';
import { passwordPolicyError } from '../utils/passwordPolicy.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';

// Team: create a user, the one team write that exists in the app (POST /api/users, Admin only). There is no
// role-change or delete route to automate. The model proposes only name, email, a suggested role and branches.
// The role (final), the AI-access checkbox (default off) and the initial password are typed by the Admin on the
// secure card and sent only in the confirm body; the model never sees them and nothing stores them.
export const TEAM_ACTIONS = { create_user: { sensitive: true } };
const SYSTEM = 'אתה עוזר בהוספת משתמשים למערכת KinderGuard. קיבלת את רשימת הסניפים. החזר JSON בלבד: {"summary": "...", "actions": [{"type": "create_user", "name": "שם מלא", "email": "כתובת", "role": "Manager"|"Admin", "branchIds": ["מזהי סניפים"]}]}. פעולה אחת לכל היותר. אל תבקש ואל תנחש סיסמה. אל תקבע הרשאת AI. אם חסר שם או דוא״ל החזר actions ריק.';
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sanitizeTeamActions = (raw, branches) => {
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const ids = new Map(branches.map((b) => [String(b._id), b.name])); const actions = []; const rejected = [];
  for (const a of Array.isArray(o.actions) ? o.actions.slice(0, 1) : []) {
    if (!a || a.type !== 'create_user') { rejected.push('סוג פעולה לא מותר'); continue; }
    const name = str(a.name, 100); const email = str(a.email, 200).toLowerCase();
    if (!name || !EMAIL.test(email)) { rejected.push('חסר שם או דוא״ל תקין'); continue; }
    const branchIds = [...new Set((Array.isArray(a.branchIds) ? a.branchIds : []).map(String).filter((x) => ids.has(x)))];
    actions.push({ type: 'create_user', domain: 'team', sensitive: true, needsNewUser: true, name, email, suggestedRole: a.role === 'Admin' ? 'Admin' : 'Manager', branchIds, branchNames: branchIds.map((x) => ids.get(x)) });
  }
  return { summary: str(o.summary, 300), actions, rejected };
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
// extra = { password, role, aiEnabled } from the confirm body (never stored, never logged).
export const runTeamAction = async (user, a, extra = {}) => {
  if (user.role !== 'Admin') throw fail(403, 'הוספת משתמשים מותרת למנהל חשבון בלבד');
  const role = extra.role; if (!['Manager', 'Admin'].includes(role)) throw fail(400, 'בחרו תפקיד');
  const perr = passwordPolicyError(extra.password); if (perr) throw fail(400, typeof perr === 'string' ? perr : 'הסיסמה אינה עומדת בכללי הסיסמה');
  let status = 200; let payload; const res = { status(c) { status = c; return res; }, json(v) { payload = v; return res; } };
  await createManagedUser({ user, body: { name: a.name, email: a.email, password: extra.password, role, accessibleBranches: role === 'Manager' ? a.branchIds : [], aiEnabled: extra.aiEnabled === true } }, res);
  if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה');
  logger.info(`ai.team.create_user by=${user._id} created=${payload?.id} role=${role} aiEnabled=${extra.aiEnabled === true}`);
  return { userId: String(payload?.id) };
};

export const createTeamActionsRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/team/propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 1000 }), handleValidation], asyncHandler(async (req, res) => {
    const adminId = getAdminId(req.user);
    const branches = await Branch.find({ adminId, kind: { $ne: 'property' } }).sort({ name: 1 }).limit(60).select('name').lean();
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: `${JSON.stringify({ branches: branches.map((b) => ({ id: String(b._id), name: b.name })) })}\n\nבקשת המשתמש: ${req.body.prompt}`, maxOutput: 600 });
      const out = sanitizeTeamActions(truncated ? '' : text, branches);
      const docs = await AiProposal.insertMany(out.actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: req.body.prompt.slice(0, 300).replace(/\S+@\S+/g, '[email]'), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })));
      logger.info(`ai.team.propose user=${req.user._id} proposed=${out.actions.length} costUsd=${costUsd}`);
      res.json({ ...out, actions: out.actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), branches: [], costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
