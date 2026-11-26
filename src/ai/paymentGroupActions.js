import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import RentPayment from '../models/RentPayment.js';
import RentPaymentGroup from '../models/RentPaymentGroup.js';
import { getAdminId } from '../utils/access.js';
import { createPaymentGroup, markGroupHanded, markGroupCleared, cancelPaymentGroup, revertGroupStatus } from '../controllers/rentController.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';

// Grouped (single physical) payments. RECORD changes only: the app never moves money. Execution calls the existing
// controllers (atomic conditional status transitions, RentAudit). Create is normal; every status change is sensitive
// (step-up, scoped to the proposal) because one click moves several payments at once. Cancel and revert need a reason.
export const GROUP_ACTIONS = {
  create_payment_group: { sensitive: false },
  group_mark_handed: { sensitive: true, from: ['Pending'], controller: markGroupHanded },
  group_mark_cleared: { sensitive: true, from: ['Pending', 'Handed'], controller: markGroupCleared },
  cancel_payment_group: { sensitive: true, from: ['Pending', 'Handed'], controller: cancelPaymentGroup, needsReason: true },
  revert_payment_group: { sensitive: true, from: ['Handed', 'Cleared'], controller: revertGroupStatus, needsReason: true },
};
const MAX_ACTIONS = 10;
const SYSTEM = 'אתה עוזר ברישום תשלומים מרוכזים (תשלום פיזי אחד לרשות שמחולק בין כמה סניפים) ב-KinderGuard. הרישום הוא עדכון סטטוס במערכת בלבד, לא ביצוע תשלום. קיבלת תשלומים ממתינים שאינם בקבוצה וקבוצות קיימות. החזר JSON בלבד: {"summary":"...","actions":[{"type":"create_payment_group","paymentIds":["id"],"dueDate":"YYYY-MM-DD","note":"..."},{"type":"group_mark_handed","groupId":"id"},{"type":"group_mark_cleared","groupId":"id"},{"type":"cancel_payment_group","groupId":"id","reason":"..."},{"type":"revert_payment_group","groupId":"id","reason":"..."}]}. לקבוצה חדשה: כל התשלומים לאותה רשות ובאותו אמצעי, ו-dueDate חייב להיות מפורש בבקשה. ביטול וביטול סימון דורשים סיבה שהמשתמש נתן. עד 10 פעולות. השתמש רק במזהים מהרשימה. אם הבקשה לא ברורה החזר actions ריק.';
const day = (d) => new Date(d).toISOString().slice(0, 10);
const iso = (d) => new Date(d).toISOString();
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
const validDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && day(s) === s;
const METHOD = { cheque: 'צ\'ק', transfer: 'העברה בנקאית' };

export const sanitizeGroupActions = (raw, { payments, groups }) => {
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const pById = new Map(payments.map((p) => [String(p._id), p])); const gById = new Map(groups.map((g) => [String(g._id), g]));
  const actions = []; const rejected = []; const usedPay = new Set(); const usedGroup = new Set();
  const list = Array.isArray(o.actions) ? o.actions : [];
  if (list.length > MAX_ACTIONS) rejected.push(`הוצעו יותר מ-${MAX_ACTIONS} פעולות. נשארו ${MAX_ACTIONS} הראשונות`);
  for (const a of list.slice(0, MAX_ACTIONS)) {
    const def = a && GROUP_ACTIONS[a.type]; if (!def) { rejected.push('סוג פעולה לא מותר'); continue; }
    if (a.type === 'create_payment_group') {
      const ids = [...new Set(Array.isArray(a.paymentIds) ? a.paymentIds.map(String) : [])];
      if (!ids.length || ids.length > 40) { rejected.push('יש לבחור בין 1 ל-40 תשלומים'); continue; }
      const ps = ids.map((i) => pById.get(i)); if (ps.some((p) => !p)) { rejected.push('חלק מהתשלומים לא מוכרים או כבר בקבוצה'); continue; }
      if (ps.some((p) => usedPay.has(String(p._id)))) { rejected.push('תשלום הופיע בשתי קבוצות'); continue; }
      if (new Set(ps.map((p) => String(p.authorityId))).size > 1) { rejected.push('כל התשלומים בקבוצה חייבים להיות לאותה רשות'); continue; }
      if (new Set(ps.map((p) => p.method)).size > 1) { rejected.push('כל התשלומים בקבוצה חייבים באותו אמצעי תשלום'); continue; }
      if (!validDay(a.dueDate)) { rejected.push('חסר מועד תשלום מפורש לקבוצה'); continue; }
      ps.forEach((p) => usedPay.add(String(p._id)));
      actions.push({ type: a.type, domain: 'payment_group', sensitive: false, authorityId: String(ps[0].authorityId), authorityName: ps[0].authorityName, method: ps[0].method, methodLabel: METHOD[ps[0].method] || '', dueDate: a.dueDate, note: str(a.note, 200), paymentIds: ps.map((p) => String(p._id)), allocations: ps.map((p) => ({ branchName: p.branchName, amount: p.amount, dueDate: day(p.dueDate) })), total: ps.reduce((s, p) => s + p.amount, 0) });
      continue;
    }
    const g = gById.get(String(a.groupId)); if (!g) { rejected.push('תשלום מרוכז לא מוכר'); continue; }
    if (usedGroup.has(String(g._id))) { rejected.push('אותו תשלום מרוכז הופיע פעמיים'); continue; } usedGroup.add(String(g._id));
    if (!def.from.includes(g.status)) { rejected.push(`"${g.authorityName}" במצב ${g.status}, הפעולה לא אפשרית`); continue; }
    if (a.type === 'group_mark_handed' && g.method !== 'cheque') { rejected.push('סימון "נמסר" רלוונטי רק לצ\'ק'); continue; }
    const reason = str(a.reason, 200); if (def.needsReason && !reason) { rejected.push('הפעולה דורשת סיבה'); continue; }
    actions.push({ type: a.type, domain: 'payment_group', sensitive: true, groupId: String(g._id), authorityName: g.authorityName, method: g.method, methodLabel: METHOD[g.method] || '', total: g.totalAmount, dueDate: day(g.dueDate), currentStatus: g.status, version: iso(g.updatedAt), reason, allocations: g.allocations.map((x) => ({ branchName: x.branchName, amount: x.amount })) });
  }
  return { summary: str(o.summary, 300), actions, rejected };
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const runGroupAction = async (user, a) => {
  if (user.role !== 'Admin') throw fail(403, 'תשלומים מרוכזים מותרים למנהל בלבד');
  let status = 200; let payload; const res = { status(c) { status = c; return res; }, json(v) { payload = v; return res; } };
  const check = () => { if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה'); };
  if (a.type === 'create_payment_group') {
    // Server re-validates every payment (still pending, ungrouped, same authority/method) inside the controller.
    await createPaymentGroup({ user, body: { authorityId: a.authorityId, method: a.method, dueDate: a.dueDate, note: a.note, paymentIds: a.paymentIds } }, res); check();
    return { groupId: String(payload?._id), total: payload?.totalAmount };
  }
  const def = GROUP_ACTIONS[a.type];
  // Precondition: the group must still be at the version and state the user saw. The transitions themselves are atomic
  // conditional updates in the controller (a concurrent clear/cancel loses with 409).
  const cur = await RentPaymentGroup.findOne({ _id: a.groupId, adminId: getAdminId(user) }).select('status updatedAt');
  if (!cur || cur.status !== a.currentStatus || +cur.updatedAt !== +new Date(a.version) || !def.from.includes(cur.status)) throw fail(409, 'מצב התשלום המרוכז השתנה מאז ההצעה. בקשו הצעה חדשה.');
  await def.controller({ user, params: { id: a.groupId }, body: { reason: a.reason || '' } }, res); check();
  return { groupId: a.groupId, status: payload?.status };
};

export const createGroupActionsRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/payment-groups/propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 2000 }), handleValidation], asyncHandler(async (req, res) => {
    const adminId = getAdminId(req.user);
    const payments = await RentPayment.find({ adminId, groupId: null, status: 'Pending' }).sort({ dueDate: 1 }).limit(100).lean();
    const groups = await RentPaymentGroup.find({ adminId, status: { $in: ['Pending', 'Handed', 'Cleared'] } }).sort({ dueDate: -1 }).limit(50).lean();
    const context = { today: day(new Date()), payments: payments.map((p) => ({ id: String(p._id), branch: p.branchName, authority: p.authorityName, authorityId: String(p.authorityId), method: p.method, amount: p.amount, dueDate: day(p.dueDate) })), groups: groups.map((g) => ({ id: String(g._id), authority: g.authorityName, method: g.method, total: g.totalAmount, dueDate: day(g.dueDate), status: g.status, branches: g.allocations.map((x) => x.branchName) })) };
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: `${JSON.stringify(context)}\n\nבקשת המשתמש: ${req.body.prompt}`, maxOutput: 2000 });
      const out = sanitizeGroupActions(truncated ? '' : text, { payments, groups });
      const docs = await AiProposal.insertMany(out.actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: req.body.prompt.slice(0, 300), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })));
      logger.info(`ai.paymentgroup.propose user=${req.user._id} proposed=${out.actions.length} costUsd=${costUsd}`);
      res.json({ ...out, actions: out.actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), branches: [], costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
