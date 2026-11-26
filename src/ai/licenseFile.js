import express from 'express';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getAdminId } from '../utils/access.js';
import logger from '../utils/logger.js';
import Branch from '../models/Branch.js';
import License from '../models/License.js';
import LicenseType from '../models/LicenseType.js';
import { readXlsxFirstSheet } from '../utils/xlsxReader.js';
import { readDocxFirstTable } from '../utils/docxReader.js';
import { requireAiAccess } from './aiAccess.js';
import { modelGrid, isModelFile } from './modelGrid.js';
import { parseFileEdits, applyFileEdits } from './filePreflight.js';
import { fileUpload, splitLine, readTextFile, unsafeCell } from './branchFile.js';
import { normName } from './branchActions.js';
import { activeUniqueIndexPresent, NO_INDEX_MESSAGE } from './licenseActions.js';

// File -> create_license proposals. Local, no model, Admin only. A license is created WITHOUT a file and only when no Active license
// exists for the branch and type (checked here and again at confirm, with the live unique index as the atomic fence). Never renews or replaces.
const MAX_ROWS = 20;
const HEAD = { branch: ['סניף', 'שם הסניף', 'מעון', 'גן', 'branch'], type: ['סוג אישור', 'סוג', 'אישור', 'type'], issueDate: ['תאריך הנפקה', 'הנפקה', 'issue', 'issuedate'], expiryDate: ['תאריך תפוגה', 'תוקף עד', 'תפוגה', 'expiry', 'expirydate'] };
const headKey = (h) => { const n = normName(h); return Object.keys(HEAD).find((k) => HEAD[k].some((x) => normName(x) === n)) || null; };
const LBL = { branch: 'סניף', type: 'סוג אישור', issueDate: 'הנפקה', expiryDate: 'תפוגה' };
const validDay = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };

export const licenseRowsFromGrid = (grid, { branches, types, activeKeys }, extra = []) => {
  const rejected = [...extra]; const lines = grid.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (lines.length < 2) return { actions: [], rejected: [...rejected, 'הקובץ ריק או בלי שורות נתונים'] };
  const keys = lines[0].map((c) => headKey(String(c ?? '').trim()));
  const miss = ['branch', 'type', 'issueDate', 'expiryDate'].filter((k) => !keys.includes(k));
  if (miss.length) return { actions: [], rejected: [...rejected, `חסרות עמודות: ${miss.map((k) => LBL[k]).join(', ')}`] };
  if (lines.length - 1 > MAX_ROWS) rejected.push(`נמצאו ${lines.length - 1} שורות. נקראו ${MAX_ROWS} הראשונות, העלו את השאר בנפרד`);
  const actions = []; const seen = new Set();
  for (const [i, cells] of lines.slice(1, MAX_ROWS + 1).entries()) {
    const r = {}; keys.forEach((k, j) => { if (k) r[k] = String(cells[j] ?? '').trim(); });
    const label = `שורה ${i + 2}`;
    const bad = Object.entries(r).filter(([k, v]) => v && unsafeCell(k, v)).map(([k]) => LBL[k]);
    if (bad.length) { rejected.push(`${label}: ערך שמתחיל בתו חשוד (= + - @) בשדות ${bad.join(', ')}. השורה לא נקלטה`); continue; }
    const bm = branches.filter((b) => normName(b.name) === normName(r.branch)); if (bm.length !== 1) { rejected.push(`${label}: הסניף "${r.branch}" ${bm.length ? 'לא חד־משמעי' : 'לא נמצא'}. השורה לא נקלטה`); continue; }
    const b = bm[0];
    const tm = types.filter((t) => normName(t.name) === normName(r.type) && (!t.branchId || String(t.branchId) === String(b._id))); if (tm.length !== 1) { rejected.push(`${label}: סוג האישור "${r.type}" ${tm.length ? 'לא חד־משמעי' : 'לא נמצא או לא פעיל'} לסניף "${b.name}". השורה לא נקלטה`); continue; }
    const t = tm[0];
    if (!validDay(r.issueDate) || !validDay(r.expiryDate)) { rejected.push(`${label}: תאריך הנפקה או תפוגה לא תקין (2026-12-31). השורה לא נקלטה`); continue; }
    if (r.expiryDate <= r.issueDate) { rejected.push(`${label}: תאריך התפוגה חייב להיות אחרי ההנפקה. השורה לא נקלטה`); continue; }
    const key = `${b._id}:${t._id}`;
    if (seen.has(key)) { rejected.push(`${label}: הסניף והסוג כבר מופיעים בשורה קודמת. השורה לא נקלטה`); continue; }
    if (activeKeys.has(key)) { rejected.push(`${label}: כבר קיים אישור פעיל "${t.name}" לסניף "${b.name}". העוזר לא מחדש ולא מחליף אישורים. השורה לא נקלטה`); continue; }
    seen.add(key);
    actions.push({ type: 'create_license', domain: 'license', sensitive: true, branchId: String(b._id), branchName: b.name, licenseTypeId: String(t._id), typeName: t.name, issueDate: r.issueDate, expiryDate: r.expiryDate });
  }
  return { actions, rejected };
};

export const createLicenseFileRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/licenses/file-propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, fileUpload.single('file'), asyncHandler(async (req, res) => {
    const f = req.file; if (!f || !f.buffer?.length) return res.status(400).json({ message: 'צרפו קובץ xlsx, docx עם טבלה או CSV.' });
    if (!(await activeUniqueIndexPresent())) return res.status(503).json({ message: NO_INDEX_MESSAGE });
    const name = f.originalname || ''; const adminId = getAdminId(req.user);
    const ed = parseFileEdits(req.body, f); if (ed.error) return res.status(400).json({ message: ed.error });
    let grid; let problems = []; let costUsd = 0; let source = 'local'; let modelErr = null; let coverage = null;
    try {
      if (/\.xlsx$/i.test(name)) { const g = readXlsxFirstSheet(f.buffer); grid = g.rows; problems = g.problems || []; }
      else if (/\.docx$/i.test(name)) { const g = readDocxFirstTable(f.buffer); grid = g.rows; problems = g.problems || []; }
      else if (isModelFile(f)) { const mg = await modelGrid({ client, f, kind: 'licenses', ed, body: req.body }); if (mg.error) { modelErr = mg.error; } else { grid = mg.grid; costUsd = mg.costUsd; source = 'model'; coverage = mg.coverage ? { ...mg.coverage, note: mg.note } : null; } }
      else { const text = readTextFile(f); if (text === null) return res.status(400).json({ message: 'בלשונית אישורים נקראים כאן רק קבצי xlsx, docx עם טבלה או CSV ליצירת אישורים. קובץ PDF או תמונה חייבים להיות קובץ תקין שנשלח עם אישור, וקבצי xls או doc ישנים: שמרו בפורמט חדש.' }); const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()); const d = [',', ';', '\t'].map((x) => [x, lines[0] ? lines[0].split(x).length : 0]).sort((a, b) => b[1] - a[1])[0][0]; grid = lines.map((l) => splitLine(l, d)); }
    } catch (e) { if (e.userMessage) return res.status(400).json({ message: e.userMessage }); return res.status(400).json({ message: 'לא ניתן לקרוא את הקובץ.' }); }
    if (modelErr) return res.status(modelErr.status).json(modelErr.body);
    const edr = applyFileEdits(grid, ed); if (edr.error) return res.status(400).json({ message: edr.error }); grid = edr.grid;
    const branches = await Branch.find({ adminId, kind: { $ne: 'property' } }).select('name').lean();
    const types = await LicenseType.find({ adminId, active: true }).select('name branchId').lean();
    const act = await License.find({ lifecycle: 'Active', branchId: { $in: branches.map((b) => b._id) } }).select('branchId licenseTypeId').lean();
    const activeKeys = new Set(act.map((l) => `${l.branchId}:${l.licenseTypeId}`));
    const { actions, rejected } = licenseRowsFromGrid(grid, { branches, types, activeKeys }, problems);
    const docs = actions.length ? await AiProposal.insertMany(actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: 'file:licenses', expiresAt: new Date(Date.now() + 30 * 60 * 1000) }))) : [];
    logger.info(`ai.licenses.file user=${req.user._id} proposed=${actions.length} rejected=${rejected.length}`);
    res.json({ summary: `${source === 'model' ? 'המסמך נקרא בעזרת Claude. בדקו כל שורה מול המסמך המקורי. ' : ''}נמצאו ${actions.length} אישורים ליצירה (בלי קובץ מצורף). כל אישור דורש אישור בנפרד:`, actions: actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), rejected, branches: [], source, costUsd, coverage, fileReview: edr.review });
  }));
  return router;
};
