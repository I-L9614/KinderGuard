import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import Authority from '../models/Authority.js';
import RentAgreement from '../models/RentAgreement.js';
import { getAdminId } from '../utils/access.js';
import { createAuthority, deleteAuthority } from '../controllers/rentController.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';
import { disambiguateActions } from './candidateDetails.js';
import { normName } from './branchActions.js';

// Payment bodies ("רשויות"): create (record) and delete (sensitive, step-up). Admin only, run by the existing controller.
// A delete is refused by the controller while the authority has an active agreement. Renaming is not covered
// (the app has no edit route for authorities).
export const AUTHORITY_ACTIONS = { create_authority: { sensitive: false }, delete_authority: { sensitive: true } };
const MAX_ACTIONS = 10;
const SYSTEM = 'אתה עוזר בניהול גופי תשלום (רשויות ובעלי נכס) ב-KinderGuard. קיבלת את הרשימה הקיימת. החזר JSON בלבד: {"summary":"...","actions":[{"type":"create_authority","name":"...","kind":"council"|"private"},{"type":"delete_authority","authorityId":"..."}]}. council היא רשות או חברה עירונית, private הוא בעל נכס פרטי. עד 10 פעולות. אל תמציא מזהים ואל תנחש גוף שלא הוזכר בבירור. אם הבקשה לא ברורה החזר actions ריק.';
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
const near = (a, b) => { const n = normName(a); const m = normName(b); return n.length >= 3 && m.length >= 3 && (m.includes(n) || n.includes(m)); };
const formulaLike = (s) => /^[=+\-@\t\r]/.test(s);

export const sanitizeAuthorityActions = (raw, authorities) => {
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const byId = new Map(authorities.map((a) => [String(a._id), a])); const actions = []; const rejected = []; const seen = new Set(); const newNames = new Set();
  const list = Array.isArray(o.actions) ? o.actions : [];
  if (list.length > MAX_ACTIONS) rejected.push(`הוצעו יותר מ-${MAX_ACTIONS} פעולות. נשארו ${MAX_ACTIONS} הראשונות`);
  for (const a of list.slice(0, MAX_ACTIONS)) {
    if (!a || !AUTHORITY_ACTIONS[a.type]) { rejected.push('סוג פעולה לא מותר'); continue; }
    if (a.type === 'create_authority') {
      const name = str(a.name, 100); if (!name) { rejected.push('חסר שם'); continue; }
      if (formulaLike(name)) { rejected.push(`השם "${name}" מתחיל בתו חשוד (= + - @) ולא נקלט`); continue; }
      const n = normName(name);
      const same = authorities.find((x) => normName(x.name) === n); if (same) { rejected.push(`כבר קיים גוף בשם "${same.name}"`); continue; }
      if (newNames.has(n)) { rejected.push(`"${name}" מופיע פעמיים בהצעה`); continue; } newNames.add(n);
      const similar = authorities.find((x) => near(name, x.name));
      actions.push({ type: 'create_authority', domain: 'authority', sensitive: false, name, kind: a.kind === 'private' ? 'private' : 'council', warning: similar ? `שם דומה לגוף קיים: "${similar.name}". ודאו שזה לא אותו גוף.` : '' });
      continue;
    }
    const cur = byId.get(String(a.authorityId));
    if (!cur) { rejected.push('גוף תשלום לא מוכר'); continue; }
    if (seen.has(String(cur._id))) { rejected.push('אותו גוף הופיע פעמיים'); continue; } seen.add(String(cur._id));
    if (cur.activeAgreements > 0) { rejected.push(`"${cur.name}": יש ${cur.activeAgreements} הסכמים פעילים. סגרו אותם לפני המחיקה`); continue; }
    const similar = authorities.filter((x) => String(x._id) !== String(cur._id) && near(cur.name, x.name));
    const needsChoice = similar.length > 0;
    actions.push({ type: 'delete_authority', domain: 'authority', sensitive: true, choiceField: 'authorityId', authorityId: needsChoice ? null : String(cur._id), name: needsChoice ? null : cur.name, kind: cur.type, version: needsChoice ? null : new Date(cur.updatedAt).toISOString(), needsChoice, candidates: needsChoice ? [cur, ...similar].map((x) => ({ id: String(x._id), name: x.name, kind: x.type, version: new Date(x.updatedAt).toISOString(), activeAgreements: x.activeAgreements })) : [], warning: needsChoice ? 'יש גופים עם שמות דומים. בחרו את הגוף המדויק לפני האישור.' : '' });
  }
  return { summary: str(o.summary, 300), actions, rejected };
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const runAuthorityAction = async (user, a) => {
  if (user.role !== 'Admin') throw fail(403, 'ניהול גופי תשלום מותר למנהל בלבד');
  const adminId = getAdminId(user);
  if (a.needsChoice || (a.type === 'delete_authority' && !a.authorityId)) throw fail(400, 'בחרו את הגוף המדויק');
  let status = 200; let payload; const res = { status(c) { status = c; return res; }, json(v) { payload = v; return res; } };
  if (a.type === 'create_authority') {
    // No unique index exists on the name, so this is a read before the write: two simultaneous identical creates could both pass.
    const all = await Authority.find({ adminId }).select('name').lean();
    if (all.some((x) => normName(x.name) === normName(a.name))) throw fail(409, 'כבר קיים גוף בשם הזה. בקשו הצעה חדשה.');
    await createAuthority({ user, checkDuplicateName: true, body: { name: a.name, type: a.kind } }, res);
    if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה');
    return { authorityId: String(payload?._id) };
  }
  // The deletion itself is conditional on the version at the database (see deleteAuthority expectedUpdatedAt).
  await deleteAuthority({ user, params: { id: a.authorityId }, expectedUpdatedAt: new Date(a.version) }, res);
  if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה');
  return { authorityId: a.authorityId, deleted: true };
};

export const createAuthorityActionsRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/authorities/propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 2000 }), handleValidation], asyncHandler(async (req, res) => {
    const adminId = getAdminId(req.user);
    const rows = await Authority.find({ adminId }).sort({ name: 1 }).limit(100).lean();
    const counts = await RentAgreement.aggregate([{ $match: { adminId, status: 'Active', authorityId: { $in: rows.map((r) => r._id) } } }, { $group: { _id: '$authorityId', n: { $sum: 1 } } }]);
    const cm = new Map(counts.map((c) => [String(c._id), c.n]));
    const authorities = rows.map((r) => ({ ...r, activeAgreements: cm.get(String(r._id)) || 0 }));
    const context = { authorities: authorities.map((x) => ({ id: String(x._id), name: x.name, kind: x.type, activeAgreements: x.activeAgreements })) };
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: `${JSON.stringify(context)}\n\nבקשת המשתמש: ${req.body.prompt}`, maxOutput: 1500 });
      const out = sanitizeAuthorityActions(truncated ? '' : text, authorities);
      out.actions = await disambiguateActions(adminId, out.actions, out.rejected);
      const docs = await AiProposal.insertMany(out.actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: req.body.prompt.slice(0, 300), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })));
      logger.info(`ai.authority.propose user=${req.user._id} proposed=${out.actions.length} costUsd=${costUsd}`);
      res.json({ ...out, actions: out.actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), branches: [], costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
