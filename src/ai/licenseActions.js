import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import License from '../models/License.js';
import LicenseType from '../models/LicenseType.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';
import { deleteLicense, deleteLicenseFile, statusForExpiry } from '../controllers/licenseController.js';
import { createLicenseType, deactivateLicenseType } from '../controllers/licenseTypeController.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';
import { normName } from '../utils/normName.js';

// Existing-approval management by the AI worker (Admin only): add a license type (normal), and three sensitive
// actions that need the server step-up: deactivate a type, move an approval to the archive, delete only an approval's
// attached file. Creating an approval itself stays in the license-extract flow. Not covered: editing an approval's fields
// (the app has no such route).
export const LICENSE_ACTIONS = { create_license: { sensitive: true }, create_license_type: { sensitive: false }, deactivate_license_type: { sensitive: true }, archive_license: { sensitive: true }, delete_license_file: { sensitive: true } };
const MAX_ACTIONS = 10;
const SYSTEM = 'אתה עוזר בניהול אישורים ב-KinderGuard. קיבלת את רשימת סוגי האישורים והאישורים הפעילים. החזר JSON בלבד: {"summary":"...","actions":[{"type":"create_license_type","name":"...","description":"...","branchId":null|"id"},{"type":"deactivate_license_type","licenseTypeId":"id"},{"type":"archive_license","licenseId":"id"},{"type":"delete_license_file","licenseId":"id"}]}. archive_license מעביר אישור לארכיון. delete_license_file מוחק רק את הקובץ המצורף. עד 10 פעולות. אל תמציא מזהים ואל תנחש יעד לא ברור. אם הבקשה לא ברורה החזר actions ריק.';
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
const iso = (d) => new Date(d).toISOString();
const day = (d) => new Date(d).toISOString().slice(0, 10);
const near = (a, b) => { const n = normName(a); const m = normName(b); return n.length >= 3 && m.length >= 3 && (m.includes(n) || n.includes(m)); };
const formulaLike = (s) => /^[=+\-@\t\r]/.test(s);

import { disambiguateActions } from './candidateDetails.js';
const licFields = (l) => ({ licenseId: String(l._id), version: iso(l.updatedAt), branchName: l.branchName, typeName: l.typeName, expiry: day(l.expiryDate), fileName: l.fileName || '' });

export const sanitizeLicenseActions = (raw, { licenses, types, branches }) => {
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const lById = new Map(licenses.map((l) => [String(l._id), l])); const tById = new Map(types.map((t) => [String(t._id), t])); const bIds = new Set(branches.map((b) => String(b._id)));
  const actions = []; const rejected = []; const seen = new Set(); const newKeys = new Set();
  const list = Array.isArray(o.actions) ? o.actions : [];
  if (list.length > MAX_ACTIONS) rejected.push(`הוצעו יותר מ-${MAX_ACTIONS} פעולות. נשארו ${MAX_ACTIONS} הראשונות`);
  for (const a of list.slice(0, MAX_ACTIONS)) {
    if (!a || !LICENSE_ACTIONS[a.type]) { rejected.push('סוג פעולה לא מותר'); continue; }
    if (a.type === 'create_license_type') {
      const name = str(a.name, 100); if (!name) { rejected.push('חסר שם לסוג האישור'); continue; }
      if (formulaLike(name)) { rejected.push(`השם "${name}" מתחיל בתו חשוד (= + - @) ולא נקלט`); continue; }
      const branchId = a.branchId ? String(a.branchId) : null;
      if (branchId && !bIds.has(branchId)) { rejected.push('סניף לא מוכר לסוג האישור'); continue; }
      const key = `${branchId}|${normName(name)}`;
      const same = types.find((t) => String(t.branchId || '') === String(branchId || '') && normName(t.name) === normName(name));
      if (same) { rejected.push(`כבר קיים סוג אישור בשם "${same.name}" בהיקף הזה`); continue; }
      if (newKeys.has(key)) { rejected.push(`"${name}" מופיע פעמיים בהצעה`); continue; } newKeys.add(key);
      const similar = types.find((t) => near(name, t.name));
      actions.push({ type: 'create_license_type', domain: 'license', sensitive: false, name, description: str(a.description, 300), branchId, branchName: branchId ? branches.find((b) => String(b._id) === branchId)?.name : '', warning: similar ? `שם דומה לסוג קיים: "${similar.name}". ודאו שזה לא אותו סוג.` : '' });
      continue;
    }
    if (a.type === 'deactivate_license_type') {
      const t = tById.get(String(a.licenseTypeId)); if (!t) { rejected.push('סוג אישור לא מוכר'); continue; }
      if (seen.has(`t${t._id}`)) { rejected.push('אותו סוג הופיע פעמיים'); continue; } seen.add(`t${t._id}`);
      actions.push({ type: 'deactivate_license_type', domain: 'license', sensitive: true, licenseTypeId: String(t._id), name: t.name, branchName: t.branchName || '', activeLicenses: t.activeLicenses || 0, warning: t.activeLicenses ? `יש ${t.activeLicenses} אישורים פעילים מהסוג הזה. הם יישארו, אבל לא ניתן יהיה להוסיף חדשים מהסוג.` : '' });
      continue;
    }
    const l = lById.get(String(a.licenseId)); if (!l) { rejected.push('אישור לא מוכר'); continue; }
    if (seen.has(`l${l._id}${a.type}`)) { rejected.push('אותו אישור הופיע פעמיים'); continue; } seen.add(`l${l._id}${a.type}`);
    if (a.type === 'delete_license_file' && !l.fileUrl) { rejected.push(`לאישור "${l.typeName}" של "${l.branchName}" אין קובץ מצורף`); continue; }
    const sibs = licenses.filter((x) => String(x._id) !== String(l._id) && x.typeName === l.typeName && near(l.branchName, x.branchName));
    const needsChoice = sibs.length > 0;
    actions.push({ type: a.type, domain: 'license', sensitive: true, choiceField: 'licenseId', needsChoice, ...(needsChoice ? { licenseId: null, version: null, branchName: null, typeName: l.typeName, expiry: null, fileName: null } : licFields(l)), candidates: needsChoice ? [l, ...sibs].map((x) => ({ id: String(x._id), name: `${x.branchName} · ${x.typeName} · עד ${day(x.expiryDate)}`, bid: String(x.branchId), fields: licFields(x) })) : [], warning: needsChoice ? 'יש סניפים עם שמות דומים לאותו סוג אישור. בחרו את האישור המדויק לפני האישור.' : '' });
  }
  return { summary: str(o.summary, 300), actions, rejected };
};

// The live-index fence lives in utils/licenseIndex.js and is shared with the manual POST /api/licenses route.
import { activeUniqueIndexPresent } from '../utils/licenseIndex.js';
export { activeUniqueIndexPresent };
export const NO_INDEX_MESSAGE = 'יצירת אישורים בעזרת העוזר לא זמינה כרגע: חסרה הגנה במסד הנתונים מפני שני אישורים פעילים לאותו סניף וסוג. לא נוצר דבר.';
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const runLicenseAction = async (user, a) => {
  if (user.role !== 'Admin') throw fail(403, 'ניהול אישורים באמצעות העוזר מותר למנהל בלבד');
  if (a.type === 'create_license') { /* handled below */ } else if (a.needsChoice || (a.type !== 'create_license_type' && a.type !== 'deactivate_license_type' && !a.licenseId)) throw fail(400, 'בחרו את האישור המדויק');
  let status = 200; let payload; const res = { status(c) { status = c; return res; }, json(v) { payload = v; return res; } };
  const check = () => { if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה'); };
  if (a.type === 'create_license') {
    if (!(await activeUniqueIndexPresent())) throw fail(503, NO_INDEX_MESSAGE);
    const adminId = getAdminId(user);
    const br = await Branch.findOne({ _id: a.branchId, adminId, kind: { $ne: 'property' } }).select('name').lean(); if (!br || br.name !== a.branchName) throw fail(409, 'הסניף השתנה או לא נמצא מאז ההצעה. בקשו הצעה חדשה.');
    const ty = await LicenseType.findOne({ _id: a.licenseTypeId, adminId, active: true, $or: [{ branchId: null }, { branchId: a.branchId }] }).select('name').lean(); if (!ty || ty.name !== a.typeName) throw fail(409, 'סוג האישור השתנה או לא פעיל מאז ההצעה. בקשו הצעה חדשה.');
    if (await License.exists({ branchId: a.branchId, licenseTypeId: a.licenseTypeId, lifecycle: 'Active' })) throw fail(409, 'כבר קיים אישור פעיל לסניף ולסוג הזה. העוזר לא מחליף ולא מחדש אישורים קיימים. לא נוצר דבר.');
    const issueDate = new Date(a.issueDate); const expiryDate = new Date(a.expiryDate);
    try { const lic = await License.create({ branchId: a.branchId, licenseTypeId: a.licenseTypeId, issueDate, expiryDate, status: statusForExpiry(expiryDate), lifecycle: 'Active', createdBy: user._id }); return { licenseId: String(lic._id) }; }
    catch (e) { if (e?.code === 11000) throw fail(409, 'כבר קיים אישור פעיל לסניף ולסוג הזה (נוצר בינתיים). לא נוצר דבר.'); throw e; }
  }
  if (a.type === 'create_license_type') { await createLicenseType({ user, body: { name: a.name, description: a.description, branchId: a.branchId || null } }, res); check(); return { licenseTypeId: String(payload?._id) }; }
  if (a.type === 'deactivate_license_type') {
    const t = await LicenseType.findOne({ _id: a.licenseTypeId, adminId: getAdminId(user), active: true }); if (!t) throw fail(409, 'סוג האישור כבר לא פעיל או לא קיים. בקשו הצעה חדשה.');
    await deactivateLicenseType({ user, params: { id: a.licenseTypeId } }, res); check(); return { licenseTypeId: a.licenseTypeId, deactivated: true };
  }
  const expectedUpdatedAt = new Date(a.version);
  if (a.type === 'archive_license') { await deleteLicense({ user, params: { id: a.licenseId }, expectedUpdatedAt }, res); check(); return { licenseId: a.licenseId, archived: true }; }
  await deleteLicenseFile({ user, params: { id: a.licenseId }, expectedUpdatedAt }, res); check();
  // The reference is removed first; the storage object may still be waiting for cleanup. Never report that as fully erased.
  const after = await License.findById(a.licenseId).select('pendingFileDeletion').lean();
  return { licenseId: a.licenseId, referenceRemoved: true, storagePending: Boolean(after?.pendingFileDeletion), fileDeleted: !after?.pendingFileDeletion };
};

export const createLicenseActionsRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/licenses/propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 2000 }), handleValidation], asyncHandler(async (req, res) => {
    const adminId = getAdminId(req.user);
    const branches = await Branch.find({ adminId }).select('name').lean(); const bn = new Map(branches.map((b) => [String(b._id), b.name]));
    const tRows = await LicenseType.find({ adminId, active: true }).sort({ name: 1 }).limit(100).lean(); const tn = new Map(tRows.map((t) => [String(t._id), t.name]));
    const lRows = await License.find({ lifecycle: 'Active', branchId: { $in: branches.map((b) => b._id) } }).sort({ expiryDate: 1 }).limit(150).lean();
    const licenses = lRows.map((l) => ({ ...l, branchName: bn.get(String(l.branchId)) || '', typeName: tn.get(String(l.licenseTypeId)) || '' }));
    const types = tRows.map((t) => ({ ...t, branchName: t.branchId ? bn.get(String(t.branchId)) || '' : '', activeLicenses: lRows.filter((l) => String(l.licenseTypeId) === String(t._id)).length }));
    const context = { branches: branches.map((b) => ({ id: String(b._id), name: b.name })), types: types.map((t) => ({ id: String(t._id), name: t.name, branchId: t.branchId ? String(t.branchId) : null, activeLicenses: t.activeLicenses })), licenses: licenses.map((l) => ({ id: String(l._id), branch: l.branchName, type: l.typeName, expiry: day(l.expiryDate), hasFile: Boolean(l.fileUrl) })) };
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: `${JSON.stringify(context)}\n\nבקשת המשתמש: ${req.body.prompt}`, maxOutput: 1500 });
      const out = sanitizeLicenseActions(truncated ? '' : text, { licenses, types, branches });
      out.actions = await disambiguateActions(adminId, out.actions, out.rejected);
      const docs = await AiProposal.insertMany(out.actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: req.body.prompt.slice(0, 300), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })));
      logger.info(`ai.license.propose user=${req.user._id} proposed=${out.actions.length} costUsd=${costUsd}`);
      res.json({ ...out, actions: out.actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), branches: [], costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
