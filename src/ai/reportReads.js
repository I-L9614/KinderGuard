import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import Branch from '../models/Branch.js';
import License from '../models/License.js';
import LicenseType from '../models/LicenseType.js';
import { rentSummary, periodAmount } from '../controllers/rentController.js';
import AiAudit from '../models/AiAudit.js';
import mongoose from 'mongoose';
import AiUserUsage from '../models/AiUserUsage.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import RentPayment from '../models/RentPayment.js';
import Authority from '../models/Authority.js';
import { loadNotificationItems } from './notificationActions.js';
import RentAgreement from '../models/RentAgreement.js';
import { getAdminId } from '../utils/access.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';
import { normName } from '../utils/normName.js';

// Read-only reports. The model only CHOOSES a report from this allowlist (and a day count); it never
// sees the data and never writes a query. The server runs a fixed query scoped to what the caller may see.
export const REPORTS = {
  licenses_expiring: { title: 'אישורים שתוקפם עומד לפוג', adminOnly: false },
  licenses_expired: { title: 'אישורים שפג תוקפם', adminOnly: false },
  licenses_all: { title: 'כל האישורים הנוכחיים בסניפים שלכם (כולל כאלה שתוקפם פג)', adminOnly: false },
  licenses_history: { title: 'היסטוריית אישורים שהוחלפו', adminOnly: false },
  licenses_chain: { title: 'שרשרת האישורים של סוג אישור בסניף (הנוכחי והקודמים לפי הקישור ביניהם)', adminOnly: false },
  licenses_no_file: { title: 'אישורים ללא קובץ מצורף', adminOnly: false },
  tasks_overdue: { title: 'משימות באיחור שפתחתם', adminOnly: false },
  branches_overview: { title: 'הסניפים שלכם', adminOnly: false },
  my_profile: { title: 'הפרטים של המשתמש שלכם', adminOnly: false },
  ai_audit: { title: 'פעולות שהעוזר ביצע בחשבון (30 הימים האחרונים)', adminOnly: true },
  ai_usage: { title: 'ניסיונות פנייה למודל דרך נתיבי העוזר, לפי משתמש (30 הימים האחרונים, תצוגה משוערת)', adminOnly: true },
  team_overview: { title: 'צוות המשתמשים בחשבון', adminOnly: true },
  notifications_open: { title: 'התראות פתוחות ובטיפול', adminOnly: false },
  authorities_overview: { title: 'גופי התשלום והסכמים פעילים', adminOnly: true },
  rent_overdue: { title: 'תשלומי שכירות שעבר מועדם ולא סומנו', adminOnly: true },
  rent_agreements: { title: 'הסכמי שכירות פעילים', adminOnly: true },
  rent_payments: { title: 'תשלומי שכירות של הסכם (לפי סניף, ואפשר גם גוף תשלום וסטטוס)', adminOnly: true },
  rent_active_totals: { title: 'סכומי שכירות של הסכמים פעילים לפי גוף תשלום', adminOnly: true },
  rent_paid_summary: { title: 'סיכום תשלומי שכירות של השנה (לפי מועד תשלום)', adminOnly: true },
};
const SYSTEM = `אתה בוחר דוח קריאה בלבד במערכת KinderGuard. החזר JSON בלבד: {"report": אחד מ-${Object.keys(REPORTS).join(', ')}, "days": מספר ימים 1-365 (רק ל-licenses_expiring, ברירת מחדל 60), "branch": "שם סניף כפי שנכתב בבקשה" (אופציונלי, רק לדוחות licenses_*), "type": "שם סוג אישור כפי שנכתב בבקשה" (אופציונלי, רק לדוחות licenses_*), "name": "טקסט שמופיע בשם הסניף, כפי שנכתב בבקשה, כשמבקשים כמה סניפים בשם דומה" (אופציונלי, רק לדוחות licenses_*), בדוח rent_agreements אפשר: "authority": "שם גוף משלם כפי שנכתב", "branch": "שם סניף כפי שנכתב", "direction": "incoming|outgoing" (כל אחד רק אם המשתמש ביקש במפורש). ובדוח team_overview אפשר: "role": "Admin|Manager", "ai": true|false, "branch": "שם סניף כפי שנכתב", "name": "חלק משם כפי שנכתב" (כל אחד רק אם המשתמש ביקש במפורש). ובדוח branches_overview אפשר גם: "status": "Active|Pending_License|Suspended", "noPayer": true (סניפים בלי גוף משלם), "payer": "שם גוף משלם כפי שנכתב", "name": "חלק משם סניף כפי שנכתב" (כל אחד רק אם המשתמש ביקש במפורש)}. רשימת אישורים שהוחלפו לסוג מסוים בסניף מסוים: licenses_history עם branch ו-type. שרשרת מלאה של אישור מסוים (הנוכחי וכל הקודמים לפי הקישור ביניהם) לסוג בסניף: licenses_chain עם branch ו-type שניהם כפי שנכתבו. תשלומי שכירות בודדים של סניף: rent_payments עם branch (חובה, כפי שנכתב), ואפשר authority ו-pstatus (Pending|Handed|Cleared|Cancelled) רק אם נכתבו במפורש. אם הבקשה לא מתאימה לאף דוח החזר {"report": null}. אין לך גישה לנתונים.`;
const USAGE_NOTE = 'תצוגה משוערת בלבד: נספרות רק פניות שעברו דרך נתיבי העוזר בשרת (כולל קריאת מסמכי אישור), לא חיוב ולא מגבלה, ייתכנו רישומים חסרים. המגבלה היחידה שנאכפת היא התקציב הכללי של המערכת.';
const AUDIT_LABELS = { upload_agreement_document: 'העלאת מסמך להסכם', create_license: 'יצירת אישור מקובץ', license_fill_save: 'שמירת אישור שמולא בעזרת העוזר', create_task: 'יצירת משימה', update_task: 'עדכון משימה', close_task: 'סגירת משימה', delete_task: 'מחיקת משימה', create_branch: 'יצירת סניף', update_branch: 'עדכון סניף', delete_branch: 'מחיקת סניף', create_user: 'יצירת משתמש', rent_mark_handed: 'סימון תשלום כנמסר', rent_mark_cleared: 'סימון תשלום כנפרע', rent_edit_payment: 'עריכת תשלום', rent_revert_payment: 'החזרת סטטוס תשלום', create_agreement: 'יצירת הסכם', update_agreement: 'עדכון הסכם', close_agreement: 'סגירת הסכם', delete_agreement_document: 'מחיקת מסמך הסכם', create_authority: 'יצירת רשות', delete_authority: 'מחיקת רשות', create_license_type: 'יצירת סוג אישור', deactivate_license_type: 'השבתת סוג אישור', archive_license: 'העברת אישור לארכיון', delete_license_file: 'מחיקת קובץ אישור', create_payment_group: 'יצירת קבוצת תשלומים', group_mark_handed: 'סימון קבוצה כנמסרה', group_mark_cleared: 'סימון קבוצה כנפרעה', cancel_payment_group: 'ביטול קבוצת תשלומים', revert_payment_group: 'החזרת סטטוס קבוצה', set_notification_status: 'שינוי סטטוס התראה' };
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export const parseReportChoice = (raw, user, prompt) => {
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { return null; }
  const def = o && REPORTS[o.report]; if (!def) return null;
  if (def.adminOnly && user.role !== 'Admin') return null;
  const days = Math.min(365, Math.max(1, Math.floor(Number(o.days)) || 60));
  const choice = { report: o.report, days };
  // Optional filters apply to license reports only. A name must be written in the user's own request: a filter the
  // model invented is never applied, and the user is told so instead of getting a silently broader report.
  if (String(o.report).startsWith('licenses_')) {
    const text = normName(prompt || '');
    for (const k of ['branch', 'type', 'name']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) continue;
      const v = o[k].trim().slice(0, 80);
      if (prompt !== undefined && !text.includes(normName(v))) choice.untraced = true; else choice[k] = v;
    }
  }
  if (o.report === 'rent_agreements') {
    const raw = String(prompt || ''); const text = normName(raw); const has = prompt !== undefined;
    if (o.direction !== undefined && o.direction !== null && o.direction !== '') { const w = { incoming: /נכנס|משלמת לנו|משלמים לנו|מקבלים/, outgoing: /יוצא|אנחנו משלמים|אנו משלמים|אני משלם/ }[o.direction]; if (w && (!has || w.test(raw))) choice.direction = o.direction; else choice.untraced = true; }
    for (const k of ['authority', 'branch']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) continue;
      const v = o[k].trim().slice(0, 80);
      if (has && !text.includes(normName(v))) choice.untraced = true; else choice[k] = v;
    }
  }
  if (o.report === 'rent_payments') {
    const raw = String(prompt || ''); const text = normName(raw); const has = prompt !== undefined;
    for (const k of ['authority', 'branch']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) continue;
      const v = o[k].trim().slice(0, 80);
      if (has && !text.includes(normName(v))) choice.untraced = true; else choice[k] = v;
    }
    if (o.pstatus !== undefined && o.pstatus !== null && o.pstatus !== '') { const w = { Pending: /ממתינ|עתידי|טרם/, Handed: /הופקד|נמסר|הוגש/, Cleared: /שולמ|נפרע|נפרעו|סולק/, Cancelled: /בוטל|מבוטל/ }[o.pstatus]; if (w && (!has || w.test(raw))) choice.pstatus = o.pstatus; else choice.untraced = true; }
  }
  if (o.report === 'team_overview') {
    const raw = String(prompt || ''); const text = normName(raw); const has = prompt !== undefined;
    if (o.role !== undefined && o.role !== null && o.role !== '') { const w = { Admin: /מנהל(ים|י)?\s*(ה)?חשבון|אדמינ|אדמין|admin/i, Manager: /מנהל(ים|י)?\s*(ה)?סני[ףפ]|manager/i }[o.role]; if (w && (!has || w.test(raw))) choice.role = o.role; else choice.untraced = true; }
    if (o.ai === true || o.ai === false) { if (!has || /(עוזר\s*)?AI|ai/i.test(raw)) choice.ai = o.ai; else choice.untraced = true; }
    for (const k of ['branch', 'name']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) continue;
      const v = o[k].trim().slice(0, 80);
      if (has && !text.includes(normName(v))) choice.untraced = true; else choice[k] = v;
    }
  }
  if (o.report === 'branches_overview') {
    const text = normName(prompt || ''); const raw = String(prompt || '');
    const STATUS_WORDS = { Active: /פעיל/, Pending_License: /ממתינ|רישיון|רשיון/, Suspended: /מושע|הושע|השעי/ };
    if (o.status !== undefined && o.status !== null && o.status !== '') { if (STATUS_WORDS[o.status] && (prompt === undefined || STATUS_WORDS[o.status].test(raw))) choice.status = o.status; else choice.untraced = true; }
    if (o.noPayer === true) { if (prompt === undefined || /(ללא|בלי|אין)[^.\n]{0,25}(גוף\s*(ה)?משלם|גוף\s*(ה)?תשלום|רשות)/.test(raw)) choice.noPayer = true; else choice.untraced = true; }
    for (const k of ['payer', 'name']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) continue;
      const v = o[k].trim().slice(0, 80);
      if (prompt !== undefined && !text.includes(normName(v))) choice.untraced = true; else choice[k] = v;
    }
    if (choice.noPayer && choice.payer) { delete choice.noPayer; choice.untraced = true; }
  }
  return choice;
};
const ambiguous = (message) => Object.assign(new Error(message), { reportMessage: message });
// Resolve a typed name to exact rows: an exact normalized match wins; otherwise exactly one containing match; else refuse.
const resolveNamed = (rows, text, label) => {
  const n = normName(text); const exact = rows.filter((r) => normName(r.name) === n);
  if (exact.length) return exact;
  const part = rows.filter((r) => normName(r.name).includes(n) || n.includes(normName(r.name)));
  const names = [...new Set(part.map((r) => r.name))];
  if (names.length === 1) return part;
  if (!names.length) throw ambiguous(`לא נמצא ${label} בשם "${text}" בין אלה שמותר לכם לראות.`);
  throw ambiguous(`יש כמה ${label === 'סניף' ? 'סניפים' : 'סוגי אישורים'} בשם דומה: ${names.slice(0, 6).join(', ')}. כתבו את השם המדויק.`);
};

export const runReport = async (user, { report, days, branch: branchText, type: typeText, status: statusFilter, noPayer, payer: payerText, name: nameText, role: roleFilter, ai: aiFilter, direction: dirFilter, authority: authText, pstatus: payStatus }, meta = {}) => {
  const adminId = getAdminId(user); const now = new Date();
  const branchFilter = { kind: { $ne: 'property' }, ...(user.role === 'Admin' ? { adminId } : { adminId, _id: { $in: user.accessibleBranches || [] } }) };
  const branches = await Branch.find(branchFilter).select('name').lean(); let ids = branches.map((b) => b._id); const nameOf = new Map(branches.map((b) => [String(b._id), b.name]));
  let typeFilter = {};
  if (String(report).startsWith('licenses_')) {
    if (branchText) ids = resolveNamed(branches, branchText, 'סניף').map((b) => b._id);
    // Free-text name: every visible branch whose name CONTAINS the text (several allowed, unlike branch which must be one). Nothing found is a refusal.
    if (nameText) { const n = normName(nameText); const hit = branches.filter((b) => normName(b.name).includes(n)); if (!hit.length) throw ambiguous(`לא נמצא סניף ששמו מכיל "${nameText}" בין אלה שמותר לכם לראות.`); const keep = new Set(hit.map((b) => String(b._id))); ids = ids.filter((i) => keep.has(String(i))); }
    if (typeText) { const all = await LicenseType.find({ adminId }).select('name').lean(); typeFilter = { licenseTypeId: { $in: resolveNamed(all, typeText, 'סוג אישור').map((t) => t._id) } }; }
  }
  if (report === 'ai_usage') {
    // Best-effort view, not billing: counts requests that reached the model client (including ones the global cap refused); failed writes are skipped.
    const since = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const users = await User.find({ $or: [{ _id: adminId }, { adminId }] }).select('name').lean(); const un = new Map(users.map((x) => [String(x._id), x.name]));
    const agg = await AiUserUsage.aggregate([{ $match: { adminId: new mongoose.Types.ObjectId(String(adminId)), day: { $gte: since } } }, { $group: { _id: '$userId', attempts: { $sum: '$attempts' } } }  , { $sort: { attempts: -1 } }]);
    meta.total = agg.length;
    const rows = agg.slice(0, 50).map((x) => ({ user: un.get(String(x._id)) || 'משתמש שנמחק', attempts: x.attempts }));
    return rows;
  }
  if (report === 'ai_audit') {
    const since = new Date(now.getTime() - 30 * 86400000);
    const users = await User.find({ $or: [{ _id: adminId }, { adminId }] }).select('name').lean(); const un = new Map(users.map((x) => [String(x._id), x.name]));
    const rows = await AiAudit.find({ adminId, at: { $gte: since } }).sort({ at: -1 }).limit(50).lean();
    return rows.map((x) => ({ when: new Date(x.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), user: un.get(String(x.userId)) || '', action: AUDIT_LABELS[x.type] || x.type, target: x.label, outcome: x.outcome === 'done' ? 'בוצע' : 'נדחה בביצוע' }));
  }
  if (report === 'my_profile') {
    // The caller's own record only (name, own email, role, AI flag, own branches). Never a password, token or another user.
    const me = await User.findById(user._id).select('name email role aiEnabled accessibleBranches').lean(); if (!me) return [];
    const mine = me.role === 'Admin' ? 'כל הסניפים' : (me.accessibleBranches || []).map((id) => nameOf.get(String(id))).filter(Boolean).join(', ') || 'אין סניפים משויכים';
    return [{ name: me.name, email: me.email, role: me.role === 'Admin' ? 'מנהל חשבון' : 'מנהל סניף', ai: me.aiEnabled ? 'עוזר AI פעיל' : 'עוזר AI כבוי', branches: mine }];
  }
  if (report === 'team_overview') {
    const allBranches = await Branch.find({ adminId }).select('name').lean(); const bn = new Map(allBranches.map((b) => [String(b._id), b.name]));
    const tq = { $or: [{ _id: adminId }, { adminId }] };
    if (roleFilter) tq.role = roleFilter;
    if (aiFilter === true) tq.aiEnabled = true; if (aiFilter === false) tq.aiEnabled = { $ne: true };
    if (nameText) tq.name = { $regex: nameText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (branchText) { const hit = resolveNamed(allBranches, branchText, 'סניף'); const hs = hit.map((b) => b._id); tq.$and = [{ $or: [{ role: 'Admin' }, { accessibleBranches: { $in: hs } }] }]; }
    meta.total = await User.countDocuments(tq);
    const users = await User.find(tq).sort({ name: 1 }).limit(meta.limit || 50).select('name role aiEnabled accessibleBranches').lean();
    return users.map((x) => ({ name: x.name, role: x.role === 'Admin' ? 'מנהל חשבון' : 'מנהל סניף', ai: x.aiEnabled ? 'עוזר AI פעיל' : '', branches: x.role === 'Admin' ? 'כל הסניפים' : (x.accessibleBranches || []).map((id) => bn.get(String(id))).filter(Boolean).join(', ') }));
  }
  if (report === 'notifications_open') {
    const items = (await loadNotificationItems(user, 100)).filter((i) => ['Open', 'In_Progress'].includes(i.status)).slice(0, 50);
    return items.map((i) => ({ branch: i.branchName, alert: i.subject, status: i.status === 'Open' ? 'פתוחה' : 'בטיפול' }));
  }
  if (report === 'authorities_overview') {
    const au = await Authority.find({ adminId }).sort({ name: 1 }).limit(100).select('name type').lean();
    const cnt = await RentAgreement.aggregate([{ $match: { adminId, status: 'Active' } }, { $group: { _id: '$authorityId', n: { $sum: 1 } } }]); const cm = new Map(cnt.map((c) => [String(c._id), c.n]));
    return au.map((x) => ({ authority: x.name, type: x.type === 'private' ? 'בעל נכס פרטי' : 'רשות', activeAgreements: `${cm.get(String(x._id)) || 0} הסכמים פעילים` }));
  }
  if (report === 'branches_overview') {
    // Branch list with optional filters (status, payer, no payer, name text). Details come from the caller's own visible branches;
    // the payer name is shown to Admins only, and a payer filter is Admin-only (managers never learn payer data).
    const filtering = statusFilter || noPayer || payerText || nameText;
    if (!filtering && user.role !== 'Admin') return branches.map((b) => ({ branch: b.name }));
    if ((noPayer || payerText) && user.role !== 'Admin') throw ambiguous('סינון לפי גוף משלם זמין למנהל החשבון בלבד.');
    let rows = await Branch.find({ _id: { $in: ids } }).select('name status managerName phone address maxChildren authorityId').sort({ name: 1 }).lean();
    const auths = user.role === 'Admin' ? await Authority.find({ adminId }).select('name').lean() : []; const an = new Map(auths.map((x) => [String(x._id), x.name]));
    if (statusFilter) rows = rows.filter((b) => (b.status || 'Active') === statusFilter);
    if (noPayer) rows = rows.filter((b) => !b.authorityId);
    if (payerText) { const hit = resolveNamed(auths, payerText, 'גוף משלם'); const set = new Set(hit.map((x) => String(x._id))); rows = rows.filter((b) => b.authorityId && set.has(String(b.authorityId))); }
    if (nameText) { const n = normName(nameText); rows = rows.filter((b) => normName(b.name).includes(n)); }
    meta.total = rows.length; const label = { Active: 'פעיל', Pending_License: 'ממתין לרישיון', Suspended: 'מושעה' };
    return rows.slice(0, 100).map((b) => ({ branch: b.name, ...(filtering || user.role === 'Admin' ? { status: label[b.status || 'Active'] || b.status, ...(user.role === 'Admin' ? { payer: b.authorityId ? (an.get(String(b.authorityId)) || '') : 'ללא' } : {}), manager: b.managerName || '', phone: b.phone || '', address: b.address || '', ...(b.maxChildren != null ? { children: `ילדים: ${b.maxChildren}` } : {}) } : {}) }));
  }
  if (report === 'tasks_overdue') {
    const t = await Task.find({ adminId, createdBy: user._id, status: { $ne: 'Done' }, dueDate: { $lt: now } }).sort({ dueDate: 1 }).limit(50).select('title dueDate branchId').lean();
    return t.map((x) => ({ title: x.title, dueDate: day(x.dueDate), branch: nameOf.get(String(x.branchId)) || '' }));
  }
  if (report === 'rent_active_totals') {
    // Reuses the exact computation behind GET /rent/summary (frequency-normalised monthly and yearly figures of ACTIVE agreements).
    let payload; const res = { status() { return res; }, json(v) { payload = v; return res; } };
    await rentSummary({ user }, res);
    const money = (x) => `${Number(x).toLocaleString('he-IL')} ₪`; const name = new Map((payload?.authorities || []).map((a) => [String(a._id), a.name]));
    const n = {}; for (const a of payload?.agreements || []) if (a.status === 'Active') { const k = String(a.authorityId?._id || a.authorityId); n[k] = (n[k] || 0) + 1; }
    return Object.entries(payload?.totals || {}).slice(0, 50).map(([k, t]) => ({ authority: name.get(k) || '', summary: `חודשי: ${money(t.monthly)} · שנתי: ${money(t.annual)} · הסכמים פעילים: ${n[k] || 0}` }));
  }
  if (report === 'rent_paid_summary') {
    // Same definition as GET /rent/reports/paid in due-date mode for the current Israeli calendar year, all authorities:
    // cleared = money that actually moved; outstanding = scheduled or handed (a cheque handed over has not cleared).
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jerusalem', year: 'numeric' }).format(now));
    const rows = await RentPayment.aggregate([{ $match: { adminId, status: { $ne: 'Cancelled' }, dueDate: { $gte: new Date(Date.UTC(year, 0, 1)), $lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) } } }, { $group: { _id: '$authorityName', cleared: { $sum: { $cond: [{ $eq: ['$status', 'Cleared'] }, '$amount', 0] } }, outstanding: { $sum: { $cond: [{ $eq: ['$status', 'Cleared'] }, 0, '$amount'] } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 50 }]);
    const money = (x) => `${Number(x).toLocaleString('he-IL')} ₪`;
    return rows.map((r) => ({ authority: r._id || '', summary: `שולם בפועל: ${money(r.cleared)} · פתוח: ${money(r.outstanding)} · תשלומים: ${r.n}` }));
  }
  if (report === 'rent_agreements') {
    // One row per ACTIVE agreement (Admin only), scheduled-payment amount as the controller computes it. Optional filters: payer, branch, direction.
    const q = { adminId, status: 'Active' };
    const [allB, allA] = await Promise.all([Branch.find({ adminId }).select('name').lean(), Authority.find({ adminId }).select('name').lean()]);
    if (branchText) q.branchId = { $in: resolveNamed(allB, branchText, 'סניף').map((b) => b._id) };
    if (authText) q.authorityId = { $in: resolveNamed(allA, authText, 'גוף משלם').map((a) => a._id) };
    if (dirFilter) q.direction = dirFilter === 'outgoing' ? { $in: ['outgoing', null] } : 'incoming';
    meta.total = await RentAgreement.countDocuments(q);
    const list = await RentAgreement.find(q).sort({ updatedAt: -1 }).limit(50).lean();
    const bn = new Map(allB.map((b) => [String(b._id), b.name])); const an = new Map(allA.map((x) => [String(x._id), x.name]));
    const FQ = { monthly: 'חודשי', quarterly: 'רבעוני', annual: 'שנתי', custom: 'מותאם' }; const money = (x) => (x == null ? 'לא הוגדר' : `${Number(x).toLocaleString('he-IL')} ₪`);
    return list.map((x) => ({ branch: bn.get(String(x.branchId)) || '', authority: an.get(String(x.authorityId)) || '', direction: x.direction === 'incoming' ? 'הרשות משלמת לכם' : 'אתם משלמים', frequency: FQ[x.frequency] || '', amount: `לתשלום: ${money(periodAmount(x))}`, method: x.paymentMethod === 'cheque' ? 'צ׳ק' : x.paymentMethod === 'transfer' ? 'העברה' : '', firstDue: x.firstDueDate ? 'פרעון ראשון ' + day(x.firstDueDate).replace(/-/g, '\u2011') : '', ...(x.chequeSeries?.seriesEndDate ? { series: `סדרת צ׳קים עד ${day(x.chequeSeries.seriesEndDate).replace(/-/g, '\u2011')}` } : {}) }));
  }
  if (report === 'rent_payments') {
    // Individual scheduled payments of ONE branch (written in the request), optionally one payer and one status written in the request. Read only.
    if (!branchText) throw ambiguous('כדי להציג תשלומי שכירות כתבו את שם הסניף.');
    const [allB, allA] = await Promise.all([Branch.find({ adminId }).select('name').lean(), Authority.find({ adminId }).select('name').lean()]);
    const hit = resolveNamed(allB, branchText, 'סניף'); if (hit.length !== 1) throw ambiguous('כתבו את שם הסניף המלא כדי להציג את התשלומים.');
    const q = { adminId, branchId: hit[0]._id, ...(payStatus ? { status: payStatus } : {}) };
    if (authText) { const au = resolveNamed(allA, authText, 'גוף תשלום'); if (au.length !== 1) throw ambiguous('כתבו את שם גוף התשלום המלא.'); q.authorityId = au[0]._id; }
    meta.total = await RentPayment.countDocuments(q);
    const ps = await RentPayment.find(q).sort({ dueDate: 1 }).limit(60).select('authorityName dueDate amount method status groupId').lean();
    const SL = { Pending: 'ממתין', Handed: 'הופקד', Cleared: 'שולם', Cancelled: 'בוטל' };
    return ps.map((x) => ({ authority: x.authorityName, dueDate: day(x.dueDate), amount: x.amount, method: x.method === 'cheque' ? 'צ׳ק' : 'העברה', status: SL[x.status] || x.status, ...(x.groupId ? { grouped: 'חלק מתשלום מרוכז' } : {}) }));
  }
  if (report === 'rent_overdue') {
    const p = await RentPayment.find({ adminId, status: 'Pending', dueDate: { $lt: now } }).sort({ dueDate: 1 }).limit(50).select('branchName authorityName dueDate amount').lean();
    return p.map((x) => ({ branch: x.branchName, authority: x.authorityName, dueDate: day(x.dueDate), amount: x.amount }));
  }
  if (report === 'licenses_chain') {
    // One branch and one type, both written in the request. Follows replacedBy backwards from the current license; rows that are not linked
    // into that chain are listed separately and labelled, never merged into it. Scope is the caller's own branches (ids).
    if (!branchText || !typeText) throw ambiguous('כדי להציג שרשרת אישורים כתבו גם את שם הסניף וגם את סוג האישור.');
    if (ids.length !== 1 || !typeFilter.licenseTypeId || typeFilter.licenseTypeId.$in.length !== 1) throw ambiguous('השרשרת מוצגת לסניף אחד ולסוג אישור אחד. כתבו את השמות המלאים.');
    const cq = { branchId: ids[0], ...typeFilter }; const total = await License.countDocuments(cq); meta.total = total; // real count, taken before the load window
    const sel = 'expiryDate issueDate fileUrl lifecycle replacedBy';
    const all = await License.find(cq).sort({ expiryDate: -1 }).limit(60).select(sel).lean();
    if (total > all.length && !all.some((l) => l.lifecycle === 'Active')) { const act = await License.findOne({ ...cq, lifecycle: 'Active' }).select(sel).lean(); if (act) all.unshift(act); }
    const incomplete = total > all.length; // the window can cut the history: never imply the last loaded row is the origin
    const byNext = new Map(); for (const l of all) if (l.replacedBy) byNext.set(String(l.replacedBy), [...(byNext.get(String(l.replacedBy)) || []), l]);
    const cur = all.find((l) => l.lifecycle === 'Active'); const chain = []; const used = new Set();
    for (let node = cur; node && !used.has(String(node._id)) && chain.length < 60;) { used.add(String(node._id)); chain.push(node); const preds = byNext.get(String(node._id)) || []; node = preds.length === 1 ? preds[0] : (preds.length > 1 ? (chain.ambiguous = true, null) : null); }
    const rest = all.filter((l) => !used.has(String(l._id)));
    const row = (l, label) => ({ position: label, issued: l.issueDate ? 'הונפק ' + day(l.issueDate).replace(/-/g, '\u2011') : '', expiryDate: 'עד ' + day(l.expiryDate).replace(/-/g, '\u2011'), file: l.fileUrl ? 'יש קובץ' : 'אין קובץ' });
    const out = chain.map((l, i) => row(l, i === 0 ? 'נוכחי' : `קודם ${i}`)).concat(rest.map((l) => row(l, incomplete ? 'לא מקושר לשרשרת בין הרשומות שנטענו' : 'לא מקושר לשרשרת')));
    if (incomplete) out.push({ position: `ההיסטוריה לא הוצגה במלואה: נטענו ${all.length} מתוך ${total} רשומות, ולכן השרשרת עשויה להיות ארוכה יותר ואין לראות באחרון שמוצג את המקור`, issued: '', expiryDate: '', file: '' });
    if (!cur && out.length) out.unshift({ position: 'אין אישור נוכחי פעיל', issued: '', expiryDate: '', file: '' });
    if (chain.ambiguous) out.push({ position: 'השרשרת מתפצלת: יותר מאישור קודם אחד מצביע על אותו אישור, ולכן לא נמשכה הלאה', issued: '', expiryDate: '', file: '' });
    return out;
  }
  if (report === 'licenses_all' || report === 'licenses_history' || report === 'licenses_no_file') {
    // Same branch scope as the other license reports (a Manager sees only assigned branches). Replaced rows are history.
    const q = report === 'licenses_history' ? { branchId: { $in: ids }, lifecycle: 'Replaced', ...typeFilter } : { branchId: { $in: ids }, lifecycle: 'Active', ...typeFilter, ...(report === 'licenses_no_file' ? { $or: [{ fileUrl: '' }, { fileUrl: null }, { fileUrl: { $exists: false } }] } : {}) };
    meta.total = await License.countDocuments(q);
    const lic = await License.find(q).sort(report === 'licenses_history' ? { updatedAt: -1 } : { expiryDate: 1 }).limit(meta.limit || 50).select('branchId licenseTypeId expiryDate issueDate fileUrl').lean();
    const types = await LicenseType.find({ _id: { $in: lic.map((l) => l.licenseTypeId) } }).select('name').lean(); const tn = new Map(types.map((x) => [String(x._id), x.name]));
    return lic.map((l) => ({ branch: nameOf.get(String(l.branchId)) || '', type: tn.get(String(l.licenseTypeId)) || '', issued: l.issueDate ? 'הונפק ' + day(l.issueDate).replace(/-/g, '\u2011') : '', expiryDate: (report === 'licenses_history' ? 'עד ' : 'בתוקף עד ') + day(l.expiryDate).replace(/-/g, '\u2011'), ...(report === 'licenses_history' ? {} : { file: l.fileUrl ? 'יש קובץ' : 'אין קובץ', ...(l.fileUrl ? { fileLicenseId: String(l._id) } : {}) }) }));
  }
  const dateFilter = report === 'licenses_expired' ? { $lt: now } : { $gte: now, $lte: new Date(now.getTime() + days * 86400000) };
  const qx = { branchId: { $in: ids }, lifecycle: 'Active', expiryDate: dateFilter, ...typeFilter }; meta.total = await License.countDocuments(qx);
  const lic = await License.find(qx).sort({ expiryDate: 1 }).limit(meta.limit || 50).select('branchId licenseTypeId expiryDate').lean();
  const types = await LicenseType.find({ _id: { $in: lic.map((l) => l.licenseTypeId) } }).select('name').lean(); const tn = new Map(types.map((x) => [String(x._id), x.name]));
  return lic.map((l) => ({ branch: nameOf.get(String(l.branchId)) || '', type: tn.get(String(l.licenseTypeId)) || '', expiryDate: day(l.expiryDate) }));
};

const EXPORT_CAP = 500;
const LICENSE_LISTS = ['licenses_all', 'licenses_history', 'licenses_no_file', 'licenses_expiring', 'licenses_expired'];
export const createReportReadsRouter = ({ client }) => {
  const router = express.Router();
  // Server-side export of the whole filtered team list (Admin only, no model call, no emails). Capped and the cap is stated.
  router.post('/reports/export-team', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, [body('role').optional().isIn(['Admin', 'Manager']), body('ai').optional().isBoolean({ strict: true }), body('branch').optional().isString().trim().isLength({ max: 80 }), body('name').optional().isString().trim().isLength({ max: 80 }), handleValidation], asyncHandler(async (req, res) => {
    const meta = { limit: EXPORT_CAP };
    try {
      const rows = await runReport(req.user, { report: 'team_overview', role: req.body.role, ai: req.body.ai, branch: req.body.branch, name: req.body.name }, meta);
      res.json({ rows, count: rows.length, total: meta.total, capped: meta.total > rows.length, cap: EXPORT_CAP });
    } catch (e) { if (e.reportMessage) return res.status(422).json({ message: e.reportMessage }); res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'הייצוא נכשל' }); }
  }));
  // Server-side export of a filtered license list beyond the 50 shown rows. Same scope as the on-screen report (a Manager only sees assigned
  // branches, enforced inside runReport), no model call, capped with the cap stated. Branch and type must resolve to exactly one name.
  router.post('/reports/export-licenses', asyncHandler(protect), requireAiAccess, [body('report').isIn(LICENSE_LISTS), body('days').optional().isInt({ min: 1, max: 365 }), body('branch').optional().isString().trim().isLength({ max: 80 }), body('type').optional().isString().trim().isLength({ max: 80 }), body('name').optional().isString().trim().isLength({ max: 80 }), handleValidation], asyncHandler(async (req, res) => {
    const meta = { limit: EXPORT_CAP };
    try {
      const rows = await runReport(req.user, { report: req.body.report, days: req.body.days ? Number(req.body.days) : 60, branch: req.body.branch, type: req.body.type, name: req.body.name }, meta);
      res.json({ rows, count: rows.length, total: meta.total, capped: meta.total > rows.length, cap: EXPORT_CAP });
    } catch (e) { if (e.reportMessage) return res.status(422).json({ message: e.reportMessage }); res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'הייצוא נכשל' }); }
  }));
  router.post('/reports/ask', asyncHandler(protect), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 1000 }), handleValidation], asyncHandler(async (req, res) => {
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: req.body.prompt, maxOutput: 200 });
      const choice = truncated ? null : parseReportChoice(text, req.user, req.body.prompt);
      if (!choice) return res.json({ report: null, rows: [], message: 'לא מצאתי דוח מתאים לבקשה. אפשר לבקש: אישורים שעומדים לפוג או שפג תוקפם, משימות באיחור, רשימת סניפים' + (req.user.role === 'Admin' ? ', שכירות באיחור.' : '.'), costUsd });
      if (choice.untraced) return res.json({ report: null, rows: [], message: 'אחד מתנאי הסינון (סניף, סוג אישור, גוף משלם, סטטוס תשלום, תפקיד, עוזר AI או שם) לא הופיע במפורש בבקשה, ולכן לא הצגתי דוח. כתבו את התנאי במפורש כפי שהוא במערכת.', costUsd });
      const meta = {}; let rows;
      try { rows = await runReport(req.user, choice, meta); } catch (e) { if (e.reportMessage) return res.json({ report: null, rows: [], message: e.reportMessage, costUsd }); throw e; }
      logger.info(`ai.report user=${req.user._id} report=${choice.report} rows=${rows.length} costUsd=${costUsd}`);
      res.json({ report: choice.report, title: REPORTS[choice.report].title, days: choice.report === 'licenses_expiring' ? choice.days : undefined, rows, count: rows.length, ...(meta.total !== undefined ? { total: meta.total } : {}), ...(choice.report === 'rent_agreements' ? { filters: [choice.authority && `גוף משלם: ${choice.authority}`, choice.branch && `סניף: ${choice.branch}`, choice.direction && `כיוון: ${choice.direction === 'incoming' ? 'הרשות משלמת לכם' : 'אתם משלמים'}`].filter(Boolean) } : {}), ...(choice.report === 'ai_usage' ? { note: USAGE_NOTE } : {}), ...(LICENSE_LISTS.includes(choice.report) ? { exportParams: { report: choice.report, ...(choice.report === 'licenses_expiring' ? { days: choice.days } : {}), ...(choice.branch ? { branch: choice.branch } : {}), ...(choice.type ? { type: choice.type } : {}), ...(choice.name ? { name: choice.name } : {}) } } : {}), ...(LICENSE_LISTS.includes(choice.report) ? { filters: [choice.branch && `סניף: ${choice.branch}`, choice.type && `סוג אישור: ${choice.type}`, choice.name && `שם סניף מכיל: ${choice.name}`].filter(Boolean) } : {}), ...(choice.report === 'team_overview' ? { exportParams: { ...(choice.role ? { role: choice.role } : {}), ...(choice.ai === true || choice.ai === false ? { ai: choice.ai } : {}), ...(choice.branch ? { branch: choice.branch } : {}), ...(choice.name ? { name: choice.name } : {}) } } : {}), ...(choice.report === 'team_overview' ? { filters: [choice.role && `תפקיד: ${choice.role === 'Admin' ? 'מנהל חשבון' : 'מנהל סניף'}`, choice.ai === true && 'עם עוזר AI', choice.ai === false && 'בלי עוזר AI', choice.branch && `סניף: ${choice.branch}`, choice.name && `שם מכיל: ${choice.name}`].filter(Boolean) } : {}), ...(choice.report === 'branches_overview' ? { filters: [choice.status && `סטטוס: ${{ Active: 'פעיל', Pending_License: 'ממתין לרישיון', Suspended: 'מושעה' }[choice.status]}`, choice.noPayer && 'ללא גוף משלם', choice.payer && `גוף משלם: ${choice.payer}`, choice.name && `שם מכיל: ${choice.name}`].filter(Boolean) } : {}), ...(choice.branch ? { branchFilter: choice.branch } : {}), ...(choice.type ? { typeFilter: choice.type } : {}), costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
