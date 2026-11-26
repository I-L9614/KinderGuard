import express from 'express';
import { body } from 'express-validator';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import Branch from '../models/Branch.js';
import Authority from '../models/Authority.js';
import { getAdminId } from '../utils/access.js';
import { createBranch, updateBranch, deleteBranch } from '../controllers/branchController.js';
import { countBranchDependents } from '../utils/branchDependents.js';
import RentAgreement from '../models/RentAgreement.js';
import License from '../models/License.js';
import Notification from '../models/Notification.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';
import { disambiguateActions } from './candidateDetails.js';

// Branch record changes: create and edit basic details. Admin only, executed by the existing branch controller.
// Deleting a branch (cascade) is NOT in this set; it needs its own sensitive design. The model may only set the
// fields below; kind stays manual. The payer link (authorityId) is set only to an exact, uniquely named payer the user named in the request.
export const BRANCH_ACTIONS = { create_branch: { sensitive: false }, update_branch: { sensitive: false }, delete_branch: { sensitive: true } };
const FIELDS = ['name', 'address', 'managerName', 'phone'];
const STATUSES = ['Active', 'Pending_License', 'Suspended'];
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
// Optional extras on the prompt path only: status (closed enum) and the contact email list (validated, deduplicated, lower-cased).
const extraFields = (a, rejected) => {
  const out = {};
  if (typeof a.status === 'string' && STATUSES.includes(a.status)) out.status = a.status;
  else if (a.status !== undefined && a.status !== null && a.status !== '') rejected.push('סטטוס סניף לא מוכר. מותר: פעיל, ממתין לרישיון, מושעה');
  if (a.emails !== undefined && a.emails !== null && a.emails !== '') {
    const list = (Array.isArray(a.emails) ? a.emails : String(a.emails).split(/[;,\n]/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const uniq = [...new Set(list)];
    if (!uniq.length || uniq.length > 10 || !uniq.every((x) => EMAIL_RE.test(x) && x.length <= 120)) rejected.push('רשימת המיילים לא תקינה (עד 10 כתובות)');
    else out.emails = uniq;
  }
  return out;
};
const MAX_BRANCHES = 60;
const KIND_WORDS = { property: /(הפוך|שנה|הסב|סווג|העבר|הגדר)[^.\n]{0,40}(ל|כ)\s*(נכס|משרד|property)/, daycare: /(הפוך|שנה|הסב|סווג|העבר|הגדר)[^.\n]{0,40}(ל|כ)\s*(מעון|daycare)/ };
export const KIND_LABEL = { daycare: 'מעון', property: 'נכס / משרד' };
const UNLINK_WORDS = /(הסר|הסרת|נתק|ניתוק|בטל|ביטול|מחק|מחיקת|הוצא|הוצאת|בלי|ללא|אין)[^.\n]{0,30}(גוף\s*(ה)?משלם|גוף\s*(ה)?תשלום|קישור|שיוך|רשות)/;
// Placeholder until the user picks one of several similar-named payers on the card; execution refuses while needsChoice is set.
export const PAYER_PENDING = '__payer_choice__';
const MAX_ACTIONS = 20;
export const beforeOf = (b, keys) => Object.fromEntries(keys.map((k) => [k, b[k] ?? '']));
const SYSTEM = 'אתה עוזר בניהול סניפי מעונות יום ב-KinderGuard. קיבלת רשימת הסניפים של המשתמש. החזר JSON בלבד: {"summary": "...", "actions": [{"type": "create_branch"|"update_branch", "branchId": "(רק ב-update)", "name": "...", "address": "...", "managerName": "...", "phone": "...", "maxChildren": מספר, "status": "Active|Pending_License|Suspended", "emails": ["..."], "authorityId": "(רק כשהמשתמש כתב במפורש את שם גוף המשלם, מתוך הרשימה authorities)", "kind": "daycare|property" (רק ב-update ורק כשהמשתמש ביקש במפורש להפוך סניף למעון או לנכס/משרד; סניפים מסוג נכס מופיעים ב-propertyBranches), "unlinkPayer": true (רק ב-update ורק כשהמשתמש ביקש במפורש להסיר את הקישור לגוף המשלם)}]}. פעולה נפרדת לכל סניף, עד 20 פעולות, בלי להכפיל סניף. כשהמשתמש מבקש שינוי לכמה סניפים, החזר פעולה לכל סניף שהוא מתייחס אליו ואל תנחש סניפים שלא הוזכרו או לא ברורים. אל תמחק סניפים. אם הבקשה לא ברורה או חסר שם סניף, החזר actions ריק.';
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
import { normName } from '../utils/normName.js';
export { normName };

// Field clipping shared with the file flow (name is the matching key there, never an update).
export const fieldsFromRow = (a) => {
  const fields = {}; for (const f of FIELDS) { if (f === 'name') continue; const v = str(a[f], f === 'address' ? 200 : 100); if (v) fields[f] = v; }
  const mc = Number(a.maxChildren); if (Number.isInteger(mc) && mc >= 0 && mc <= 500 && a.maxChildren !== null && a.maxChildren !== '' && a.maxChildren !== undefined) fields.maxChildren = mc;
  return fields;
};

export const sanitizeBranchActions = (raw, branches, deps = new Map(), authorities = [], prompt = '', propertyBranches = []) => {
  const propById = new Map(propertyBranches.map((b) => [String(b._id), b]));
  const authName = new Map(authorities.map((x) => [String(x._id), x.name])); const pn = normName(prompt);
  let o; try { o = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const byId = new Map(branches.map((b) => [String(b._id), b])); const actions = []; const rejected = []; const seen = new Set();
  if (Array.isArray(o.actions) && o.actions.length > MAX_ACTIONS) rejected.push(`הוצעו יותר מ-${MAX_ACTIONS} סניפים. נשארו ${MAX_ACTIONS} הראשונים, בקשו את השאר בנפרד`);
  for (const a of Array.isArray(o.actions) ? o.actions.slice(0, MAX_ACTIONS) : []) {
    if (a && a.type === 'update_branch' && seen.has(String(a.branchId))) { rejected.push('אותו סניף הופיע פעמיים. נשמרה ההצעה הראשונה'); continue; }
    if (!a || !BRANCH_ACTIONS[a.type]) { rejected.push('סוג פעולה לא מותר'); continue; }
    if (a.type === 'delete_branch') {
      const cur = byId.get(String(a.branchId)); if (!cur) { rejected.push('סניף לא מוכר'); continue; }
      if (seen.has(String(cur._id))) { rejected.push('אותו סניף הופיע פעמיים. נשמרה ההצעה הראשונה'); continue; }
      const d = deps.get(String(cur._id)); if (!d) { rejected.push('לא ניתן לספור את התלויים של הסניף'); continue; }
      if (d.activeAgreements > 0) { rejected.push(`לסניף "${cur.name}" יש ${d.activeAgreements} הסכמי שכירות פעילים. סגרו אותם לפני המחיקה`); continue; }
      const snap = (b) => { const x = deps.get(String(b._id)) || {}; return { licenses: x.licenses, files: x.files, alerts: x.alerts, closedAgreements: x.closedAgreements, version: new Date(b.updatedAt || 0).toISOString() }; };
      const similar = branches.filter((b) => String(b._id) !== String(cur._id) && deps.get(String(b._id)) && (() => { const n2 = normName(cur.name); const m = normName(b.name); return n2.length >= 3 && m.length >= 3 && (m.includes(n2) || n2.includes(m)); })());
      const needsChoice = similar.length > 0; seen.add(String(cur._id));
      actions.push({ type: 'delete_branch', domain: 'branch', sensitive: true, branchId: needsChoice ? null : String(cur._id), currentName: needsChoice ? null : cur.name, before: needsChoice ? null : snap(cur), needsChoice, candidates: needsChoice ? [cur, ...similar].filter((b) => !(deps.get(String(b._id)).activeAgreements > 0)).map((b) => ({ id: String(b._id), name: b.name, before: snap(b) })) : [], fields: {}, warning: needsChoice ? 'יש סניפים עם שמות דומים. בחרו את הסניף המדויק לפני האישור.' : '' });
      continue;
    }
    const fields = {}; for (const f of FIELDS) { const v = str(a[f], f === 'address' ? 200 : 100); if (v) fields[f] = v; }
    Object.assign(fields, extraFields(a, rejected));
    // Payer link: only an existing payer, whose name the user actually wrote, with no similar-named sibling payer (the user must then name it uniquely).
    let authorityNames = null; let payerChoice = null;
    if (a.authorityId !== undefined && a.authorityId !== null && a.authorityId !== '') {
      const au = authorities.find((x) => String(x._id) === String(a.authorityId)); const an = au ? normName(au.name) : '';
      const sib = au ? authorities.filter((x) => String(x._id) !== String(au._id) && (normName(x.name).includes(an) || an.includes(normName(x.name)))) : [];
      if (!au) rejected.push('גוף משלם לא מוכר');
      else if (an.length < 2 || !pn.includes(an)) rejected.push(`שם גוף המשלם "${au.name}" לא הופיע בבקשה. כתבו אותו במפורש`);
      else if (sib.length) { payerChoice = [au, ...sib]; fields.authorityId = PAYER_PENDING; authorityNames = Object.fromEntries(payerChoice.map((x) => [String(x._id), x.name])); }
      else { fields.authorityId = String(au._id); authorityNames = { [String(au._id)]: au.name }; }
    }
    const mc = Number(a.maxChildren); if (Number.isInteger(mc) && mc >= 0 && mc <= 500 && a.maxChildren !== null && a.maxChildren !== '') fields.maxChildren = mc;
    // Unlink the payer: only on an existing branch, only when the request itself says to remove the link, never together with a new payer.
    if (a.unlinkPayer === true) {
      if (a.type !== 'update_branch') rejected.push('אפשר לנתק גוף משלם רק מסניף קיים');
      else if (fields.authorityId) rejected.push('אי אפשר גם לקשר גוף משלם וגם לנתק בבקשה אחת');
      else if (!UNLINK_WORDS.test(String(prompt))) rejected.push('ניתוק גוף המשלם לא הופיע במפורש בבקשה. כתבו שרוצים להסיר את הקישור לגוף המשלם');
      else fields.authorityId = '';
    }
    const src = a.type === 'update_branch' ? (byId.get(String(a.branchId)) || (a.kind ? propById.get(String(a.branchId)) : null)) : null;
    const cur = src ? { ...src, kind: src.kind || 'daycare' } : null;
    if (a.type === 'update_branch' && !cur) { rejected.push('סניף לא מוכר'); continue; }
    // Branch kind: property branches are hidden from the daycare screens (licenses, alerts, team, reports), so a daycare may become a
    // property only when it has no licenses, files or alerts that would silently disappear from view. The request must say so explicitly.
    if (a.kind !== undefined && a.kind !== null && a.kind !== '') {
      if (!KIND_LABEL[a.kind]) rejected.push('סוג סניף לא מוכר. מותר: מעון או נכס/משרד');
      else if (a.type !== 'update_branch') rejected.push('סוג סניף נקבע רק בעדכון סניף קיים');
      else if (a.kind === cur.kind) rejected.push(`הסניף כבר מסוג ${KIND_LABEL[a.kind]}`);
      else if (!KIND_WORDS[a.kind].test(String(prompt))) rejected.push('שינוי סוג הסניף לא הופיע במפורש בבקשה. כתבו למשל "הפוך את הסניף לנכס" או "הפוך אותו למעון"');
      else if (a.kind === 'property') rejected.push(`הפיכת סניף מעון לנכס אינה נתמכת בעוזר כרגע, כי אין עדיין הגנה שמונעת יצירת אישור בו־זמנית שהיה נעלם ממסכי המעונות. הסניף "${cur.name}" לא שונה. אפשר להפוך נכס חזרה למעון.`);
      else fields.kind = 'daycare';
    }
    if (a.type === 'create_branch' && !fields.name) { rejected.push('חסר שם סניף'); continue; }
    if (cur) { if (cur.authorityId) authorityNames = { ...(authorityNames || {}), [String(cur.authorityId)]: authName.get(String(cur.authorityId)) || '' }; for (const f of Object.keys(fields)) if (String(cur[f] ?? '') === String(fields[f])) delete fields[f]; if (!Object.keys(fields).length) { rejected.push('אין שינוי'); continue; } }
    const others = branches.filter((b) => !cur || String(b._id) !== String(cur._id)); let warning = ''; let blocked = false;
    if (fields.name) {
      const n = normName(fields.name);
      const same = others.find((b) => normName(b.name) === n);
      if (same) { rejected.push(`כבר קיים סניף בשם "${same.name}"`); blocked = true; }
      else { const near = others.find((b) => { const m = normName(b.name); return n.length >= 3 && m.length >= 3 && (m.includes(n) || n.includes(m)); }); if (near) warning = `שם דומה לסניף קיים: "${near.name}". ודאו שזה לא אותו סניף.`; }
    }
    if (fields.kind === 'property') warning = [warning, 'הסניף יוסתר ממסכי המעונות, האישורים, הצוות והדוחות. רשומות הסכמי השכירות לא נערכות בפעולה הזו.'].filter(Boolean).join(' ');
    if (fields.kind === 'daycare') warning = [warning, 'הסניף יופיע מעתה ברשימות המעונות, באישורים, בצוות ובדוחות.'].filter(Boolean).join(' ');
    if (blocked) continue;
    // An update whose target has a similar-named sibling is NOT auto-selected: the user must pick the exact branch on the card.
    const similar = cur ? others.filter((b) => { const n2 = normName(cur.name); const m = normName(b.name); return n2.length >= 3 && m.length >= 3 && (m.includes(n2) || n2.includes(m)); }) : [];
    const needsChoice = similar.length > 0;
    if (cur) seen.add(String(cur._id));
    const keys = Object.keys(fields);
    actions.push({ type: a.type, domain: 'branch', sensitive: false, branchId: cur && !needsChoice ? String(cur._id) : null, currentName: cur && !needsChoice ? cur.name : null, before: cur && !needsChoice ? beforeOf(cur, keys) : null, needsChoice, candidates: needsChoice ? [cur, ...similar].map((b) => ({ id: String(b._id), name: b.name, before: beforeOf(b, keys) })) : [], fields, ...(fields.authorityId !== undefined ? { authorityNames: Object.fromEntries([...(authorityNames ? Object.entries(authorityNames) : []), ...[cur, ...similar].filter((x) => x?.authorityId).map((x) => [String(x.authorityId), authName.get(String(x.authorityId)) || ''])]) } : {}), warning: needsChoice ? 'יש סניפים עם שמות דומים. בחרו את הסניף המדויק לפני האישור.' : warning });
    if (payerChoice) {
      if (needsChoice) { actions.pop(); rejected.push('גם הסניף וגם גוף המשלם דומים לאחרים. בקשו שינוי אחד בכל פעם, עם שם מלא'); continue; }
      Object.assign(actions[actions.length - 1], { needsChoice: true, choiceField: 'branchPayer', candidates: payerChoice.map((x) => ({ id: String(x._id), name: x.name })), warning: 'יש כמה גופי משלם בשמות דומים. בחרו את הגוף המדויק לפני האישור.' });
    }
  }
  return { summary: str(o.summary, 300), actions, rejected };
};

const SYSTEM_DELETE = ' מחיקת סניף: {"type":"delete_branch","branchId":"id"} רק כשהמשתמש ביקש במפורש למחוק סניף אחד בשמו. מחיקה מוחקת גם את כל האישורים (כולל היסטוריה), הקבצים וההתראות של הסניף. אל תציע מחיקה כדי לתקן או לאחד שמות.';
const loadDeps = async (branches) => {
  const m = new Map(); const ids = branches.map((b) => b._id); if (!ids.length) return m;
  const grp = (Model, match) => Model.aggregate([{ $match: { branchId: { $in: ids }, ...match } }, { $group: { _id: '$branchId', n: { $sum: 1 } } }]);
  const [lic, files, alerts, act, closed] = await Promise.all([grp(License, {}), grp(License, { fileUrl: { $ne: '' } }), grp(Notification, {}), grp(RentAgreement, { status: 'Active' }), grp(RentAgreement, { status: { $ne: 'Active' } })]);
  const at = (rows) => new Map(rows.map((r) => [String(r._id), r.n]));
  const [L, F, A, G, C] = [lic, files, alerts, act, closed].map(at);
  for (const b of branches) { const k = String(b._id); m.set(k, { licenses: L.get(k) || 0, files: F.get(k) || 0, alerts: A.get(k) || 0, activeAgreements: G.get(k) || 0, closedAgreements: C.get(k) || 0 }); }
  return m;
};
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
// Runs the existing controller. Re-checks at execution that no branch took the name since the proposal, and (update) that the branch is unchanged.
export const runBranchAction = async (user, a) => {
  if (user.role !== 'Admin') throw fail(403, 'עריכת סניפים מותרת למנהל בלבד');
  if (a.needsChoice || (a.type === 'update_branch' && !a.branchId)) throw fail(400, 'בחרו את הסניף המדויק');
  if (a.fields?.authorityId === PAYER_PENDING) throw fail(400, 'בחרו את גוף המשלם המדויק');
  const adminId = getAdminId(user);
  if (a.type === 'delete_branch') {
    if (!a.branchId || !a.before) throw fail(400, 'בחרו את הסניף המדויק');
    const cur = await Branch.findOne({ _id: a.branchId, adminId }).select('name updatedAt').lean(); if (!cur) throw fail(404, 'הסניף לא נמצא');
    if (cur.name !== a.currentName || new Date(cur.updatedAt).toISOString() !== a.before.version) throw fail(409, 'פרטי הסניף השתנו מאז ההצעה. בקשו הצעה חדשה.');
    // Advisory pre-check only. The authoritative check runs inside the controller after it claims the branch.
    const live = await countBranchDependents(cur._id);
    if (live.activeAgreements > 0) throw fail(409, `לסניף יש ${live.activeAgreements} הסכמי שכירות פעילים. סגרו אותם לפני המחיקה.`);
    let st = 200; let pl; const rs = { status(c) { st = c; return rs; }, json(v) { pl = v; return rs; } };
    await deleteBranch({ user, params: { id: a.branchId }, expectedBranch: { name: a.currentName, updatedAt: new Date(a.before.version) }, expectedDependents: { licenses: a.before.licenses, files: a.before.files, alerts: a.before.alerts, activeAgreements: 0 } }, rs);
    if (st >= 400) throw fail(st, pl?.message || 'הפעולה נכשלה');
    return { branchId: a.branchId, branchDeleted: true, deletedLicenses: pl?.deletedLicenses ?? 0, pendingCleanup: pl?.pendingCleanup ?? 0 };
  }
  const all = (await Branch.find({ adminId }).select('name address managerName phone maxChildren emails status authorityId kind').lean()).map((b) => ({ ...b, kind: b.kind || 'daycare' }));
  if (a.type === 'update_branch' && a.fields?.kind === 'property') throw fail(409, 'הפיכת סניף מעון לנכס אינה נתמכת בעוזר. סוג הסניף לא שונה.');
  if (a.fields?.authorityId) { const au = await Authority.findOne({ _id: a.fields.authorityId, adminId, deleting: { $ne: true } }).select('name').lean(); if (!au || au.name !== a.authorityNames?.[String(a.fields.authorityId)]) throw fail(409, 'גוף המשלם השתנה או לא נמצא מאז ההצעה. בקשו הצעה חדשה.'); }
  if (a.fields?.name) { const n = normName(a.fields.name); if (all.some((b) => (!a.branchId || String(b._id) !== a.branchId) && normName(b.name) === n)) throw fail(409, 'כבר קיים סניף בשם הזה. בקשו הצעה חדשה.'); }
  if (a.type === 'update_branch') { const cur = all.find((b) => String(b._id) === a.branchId); if (!cur) throw fail(404, 'הסניף לא נמצא'); if (a.before) for (const [k, v] of Object.entries(a.before)) if (String(cur[k] ?? '') !== String(v ?? '')) throw fail(409, 'הסניף השתנה מאז ההצעה. בקשו הצעה חדשה.');
    if (cur.name !== a.currentName) throw fail(409, 'הסניף השתנה מאז ההצעה. בקשו הצעה חדשה.'); }
  let status = 200; let payload; const res = { status(c) { status = c; return res; }, json(v) { payload = v; return res; } };
  await (a.type === 'create_branch' ? createBranch : updateBranch)({ user, params: { id: a.branchId }, body: a.fields, expectedBefore: a.type === 'update_branch' ? a.before : undefined }, res);
  if (status >= 400) throw fail(status, payload?.message || 'הפעולה נכשלה');
  let persistedPayerName;
  if (payload?.payerLinkFailed && payload.authorityId) { const cur = await Authority.findOne({ _id: payload.authorityId, adminId, deleting: { $ne: true } }).select('name').lean(); persistedPayerName = cur?.name; }
  return { branchId: String(payload?._id || a.branchId), ...(payload?.payerLinkFailed ? { payerLinkFailed: true, ...(persistedPayerName ? { persistedPayerName } : {}) } : {}) };
};

export const createBranchActionsRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/branches/propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, [body('prompt').isString().trim().isLength({ min: 1, max: 2000 }), handleValidation], asyncHandler(async (req, res) => {
    const adminId = getAdminId(req.user);
    const branches = await Branch.find({ adminId, kind: { $ne: 'property' } }).sort({ name: 1 }).limit(MAX_BRANCHES).select('name address managerName phone maxChildren emails status authorityId updatedAt').lean();
    const authorities = await Authority.find({ adminId }).sort({ name: 1 }).limit(100).select('name').lean();
    const propertyBranches = await Branch.find({ adminId, kind: 'property' }).sort({ name: 1 }).limit(MAX_BRANCHES).select('name address managerName phone maxChildren emails status authorityId kind updatedAt').lean();
    const context = { branches: branches.map((b) => ({ id: String(b._id), name: b.name, address: b.address || '', managerName: b.managerName || '', phone: b.phone || '', maxChildren: b.maxChildren ?? null, status: b.status || 'Active', emails: b.emails || [], authorityId: b.authorityId ? String(b.authorityId) : null })), authorities: authorities.map((x) => ({ id: String(x._id), name: x.name })), propertyBranches: propertyBranches.map((b) => ({ id: String(b._id), name: b.name })) };
    try {
      const { text, costUsd, truncated } = await client.ask({ system: SYSTEM + SYSTEM_DELETE, prompt: `${JSON.stringify(context)}\n\nבקשת המשתמש: ${req.body.prompt}`, maxOutput: 3500 });
      const deps = await loadDeps(branches);
      const out = sanitizeBranchActions(truncated ? '' : text, branches, deps, authorities, req.body.prompt, propertyBranches);
      out.actions = await disambiguateActions(adminId, out.actions, out.rejected);
      const docs = await AiProposal.insertMany(out.actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: req.body.prompt.slice(0, 300), expiresAt: new Date(Date.now() + 30 * 60 * 1000) })));
      logger.info(`ai.branch.propose user=${req.user._id} proposed=${out.actions.length} costUsd=${costUsd}`);
      res.json({ ...out, actions: out.actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), branches: [], costUsd });
    } catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' }); }
  }));
  return router;
};
