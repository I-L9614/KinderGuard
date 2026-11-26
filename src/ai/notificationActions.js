import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import Notification from '../models/Notification.js';
import RentReminder from '../models/RentReminder.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';
import { updateNotification } from '../controllers/notificationController.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';

// Alerts inbox: change the handling status of an existing alert (license or rent reminder). Normal tier (the status
// can be changed back). Admin sees the account, Manager only the alerts of assigned branches (the controller scope).
export const NOTIFICATION_ACTIONS = { set_notification_status: { sensitive: false } };
const STATUSES = { Open: 'פתוחה', In_Progress: 'בטיפול', Resolved: 'טופלה', Dismissed: 'נדחתה' };
const MAX_ACTIONS = 20;
const SYSTEM = 'אתה עוזר בניהול התראות ב-KinderGuard. קיבלת רשימת התראות. החזר JSON בלבד: {"summary":"...","actions":[{"type":"set_notification_status","notificationId":"id","kind":"License"|"Rent","status":"Open"|"In_Progress"|"Resolved"|"Dismissed"}]}. עד 20 פעולות. השתמש רק במזהים מהרשימה ואל תנחש התראה לא ברורה. אם הבקשה לא ברורה החזר actions ריק.';
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const TRIG = { 30: 'עד 30 יום לפקיעה', 7: 'עד 7 ימים לפקיעה', 0: 'פג תוקף' };
const RTRIG = { week_before_due: 'תשלום שכירות בעוד שבוע', month_before_series_end: 'סיום סדרת תשלומים בעוד חודש' };

export const sanitizeNotificationActions = (raw, items) => {
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const byKey = new Map(items.map((i) => [`${i.kind}:${i.id}`, i])); const actions = []; const rejected = []; const seen = new Set();
  const list = Array.isArray(o.actions) ? o.actions : [];
  if (list.length > MAX_ACTIONS) rejected.push(`הוצעו יותר מ-${MAX_ACTIONS} פעולות. נשארו ${MAX_ACTIONS} הראשונות`);
  for (const a of list.slice(0, MAX_ACTIONS)) {
    if (!a || a.type !== 'set_notification_status') { rejected.push('סוג פעולה לא מותר'); continue; }
    const cur = byKey.get(`${a.kind === 'Rent' ? 'Rent' : 'License'}:${String(a.notificationId)}`);
    if (!cur) { rejected.push('התראה לא מוכרת'); continue; }
    if (!STATUSES[a.status]) { rejected.push('מצב טיפול לא מותר'); continue; }
    if (a.status === cur.status) { rejected.push(`"${cur.subject}" כבר במצב ${STATUSES[cur.status]}`); continue; }
    if (seen.has(`${cur.kind}:${cur.id}`)) { rejected.push('אותה התראה הופיעה פעמיים'); continue; } seen.add(`${cur.kind}:${cur.id}`);
    actions.push({ type: 'set_notification_status', domain: 'notification', sensitive: false, notificationId: cur.id, kind: cur.kind, branchName: cur.branchName, subject: cur.subject, from: cur.status, to: a.status, fromLabel: STATUSES[cur.status], toLabel: STATUSES[a.status], version: cur.version });
  }
  return { summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 300) : '', actions, rejected };
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const runNotificationAction = async (user, a) => {
  if (!['Admin', 'Manager'].includes(user.role)) throw fail(403, 'אין הרשאה');
  let status = 200; let payload; const res = { status(c) { status = c; return res; }, json(v) { payload = v; return res; } };
  await updateNotification({ user, params: { id: a.notificationId }, body: { status: a.to }, expectedUpdatedAt: new Date(a.version), expectedKind: a.kind }, res);
  if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה');
  return { notificationId: a.notificationId, status: a.to };
};

export const loadNotificationItems = async (user, limit = 100) => {
  const adminId = getAdminId(user); const filter = { adminId };
  if (user.role === 'Manager') filter.branchId = { $in: user.accessibleBranches || [] };
  const [lic, rent] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).populate('branchId', 'name').populate({ path: 'licenseId', populate: { path: 'licenseTypeId', select: 'name' } }).lean(),
    RentReminder.find(filter).sort({ createdAt: -1 }).limit(limit).populate('branchId', 'name').lean(),
  ]);
  return [
    ...lic.map((n) => ({ id: String(n._id), kind: 'License', status: n.status, branchName: n.branchId?.name || '', subject: `${n.licenseId?.licenseTypeId?.name || 'אישור'} · ${TRIG[n.triggerDays] || ''}${n.licenseId?.expiryDate ? ` · בתוקף עד ${day(n.licenseId.expiryDate)}` : ''}`, version: new Date(n.updatedAt).toISOString(), createdAt: n.createdAt })),
    ...rent.map((n) => ({ id: String(n._id), kind: 'Rent', status: n.status, branchName: n.branchId?.name || n.branchName || '', subject: `${RTRIG[n.rentTrigger] || 'שכירות'}${n.dueDate ? ` · מועד ${day(n.dueDate)}` : ''}`, version: new Date(n.updatedAt).toISOString(), createdAt: n.createdAt })),
  ].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, limit);
};

export const createNotificationActionsRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/notifications/propose', asyncHandler(protect), authorizeRoles('Admin', 'Manager'), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 2000 }), handleValidation], asyncHandler(async (req, res) => {
    const adminId = getAdminId(req.user);
    const items = await loadNotificationItems(req.user);
    const context = { notifications: items.map((i) => ({ id: i.id, kind: i.kind, branch: i.branchName, subject: i.subject, status: i.status })) };
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: `${JSON.stringify(context)}\n\nבקשת המשתמש: ${req.body.prompt}`, maxOutput: 2000 });
      const out = sanitizeNotificationActions(truncated ? '' : text, items);
      const docs = await AiProposal.insertMany(out.actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: req.body.prompt.slice(0, 300), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })));
      logger.info(`ai.notification.propose user=${req.user._id} proposed=${out.actions.length} costUsd=${costUsd}`);
      res.json({ ...out, actions: out.actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), branches: [], costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
