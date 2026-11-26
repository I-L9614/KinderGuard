import express from 'express';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getAdminId } from '../utils/access.js';
import logger from '../utils/logger.js';
import Branch from '../models/Branch.js';
import { readXlsxFirstSheet } from '../utils/xlsxReader.js';
import { readDocxFirstTable } from '../utils/docxReader.js';
import { requireAiAccess } from './aiAccess.js';
import { modelGrid, isModelFile } from './modelGrid.js';
import { parseFileEdits, applyFileEdits } from './filePreflight.js';
import { fileUpload, splitLine, readTextFile, unsafeCell } from './branchFile.js';
import { normName } from './branchActions.js';
import { sanitizeTeamActions } from './teamActions.js';

// File -> create_user proposals, local only, no model. Admin only. Each row is its own sensitive card: the password is typed
// by the admin on the card and the step-up applies per card, exactly as for a user created from chat. The file never carries a password.
const MAX_ROWS = 20;
const HEAD = { name: ['שם', 'שם מלא', 'name', 'fullname'], email: ['אימייל', 'דוא"ל', 'דואל', 'מייל', 'email', 'mail'], role: ['תפקיד', 'role'], branches: ['סניפים', 'סניף', 'branches', 'branch'] };
const headKey = (h) => { const n = normName(h); return Object.keys(HEAD).find((k) => HEAD[k].some((x) => normName(x) === n)) || null; };
const ROLE = (v) => { const n = normName(v); if (['admin', 'מנהל חשבון', 'מנהלת חשבון', 'אדמין'].includes(n)) return 'Admin'; if (['manager', 'מנהל סניף', 'מנהלת סניף'].includes(n)) return 'Manager'; return null; };
const LBL = { name: 'שם', email: 'אימייל', role: 'תפקיד', branches: 'סניפים' };

export const teamRowsFromGrid = (grid, branches, extra = []) => {
  const rejected = [...extra]; const lines = grid.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (lines.length < 2) return { actions: [], rejected: [...rejected, 'הקובץ ריק או בלי שורות נתונים'] };
  const keys = lines[0].map((c) => headKey(String(c ?? '').trim()));
  if (!keys.includes('name') || !keys.includes('email')) return { actions: [], rejected: [...rejected, 'חסרות עמודות שם ואימייל'] };
  if (lines.length - 1 > MAX_ROWS) rejected.push(`נמצאו ${lines.length - 1} שורות. נקראו ${MAX_ROWS} הראשונות, העלו את השאר בנפרד`);
  const actions = []; const seen = new Set();
  for (const [i, cells] of lines.slice(1, MAX_ROWS + 1).entries()) {
    const r = {}; keys.forEach((k, j) => { if (k) r[k] = String(cells[j] ?? '').trim(); });
    const label = `שורה ${i + 2}`;
    const bad = Object.entries(r).filter(([k, v]) => v && unsafeCell(k, v)).map(([k]) => LBL[k]);
    if (bad.length) { rejected.push(`${label}: ערך שמתחיל בתו חשוד (= + - @) בשדות ${bad.join(', ')}. השורה לא נקלטה`); continue; }
    const email = (r.email || '').toLowerCase();
    if (seen.has(email)) { rejected.push(`${label}: האימייל ${email} כבר מופיע בשורה קודמת. השורה לא נקלטה`); continue; }
    let role = 'Manager';
    if (r.role) { role = ROLE(r.role); if (!role) { rejected.push(`${label}: התפקיד "${r.role}" לא מוכר (מנהל חשבון או מנהל סניף). השורה לא נקלטה`); continue; } }
    const ids = []; let badBranch = null;
    for (const nm of String(r.branches || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean)) { const m = branches.filter((b) => normName(b.name) === normName(nm)); if (m.length !== 1) { badBranch = nm; break; } ids.push(String(m[0]._id)); }
    if (badBranch) { rejected.push(`${label}: הסניף "${badBranch}" לא נמצא או לא חד־משמעי. השורה לא נקלטה`); continue; }
    const out = sanitizeTeamActions(JSON.stringify({ actions: [{ type: 'create_user', name: r.name, email, role, branchIds: ids }] }), branches);
    if (!out.actions.length) { rejected.push(`${label}: חסר שם או אימייל תקין. השורה לא נקלטה`); continue; }
    seen.add(email); actions.push(...out.actions);
  }
  return { actions, rejected };
};

export const createTeamFileRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/team/file-propose', asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess, fileUpload.single('file'), asyncHandler(async (req, res) => {
    const f = req.file; if (!f || !f.buffer?.length) return res.status(400).json({ message: 'צרפו קובץ xlsx, docx עם טבלה או CSV.' });
    const name = f.originalname || ''; const adminId = getAdminId(req.user);
    const branches = await Branch.find({ adminId, kind: { $ne: 'property' } }).select('name').lean();
    let grid; let problems = []; let costUsd = 0; let source = 'local'; let modelErr = null; let coverage = null;
    const ed = parseFileEdits(req.body, f); if (ed.error) return res.status(400).json({ message: ed.error });
    try {
      if (/\.xlsx$/i.test(name)) { const g = readXlsxFirstSheet(f.buffer); grid = g.rows; problems = g.problems || []; }
      else if (/\.docx$/i.test(name)) { const g = readDocxFirstTable(f.buffer); grid = g.rows; problems = g.problems || []; }
      else if (isModelFile(f)) { const mg = await modelGrid({ client, f, kind: 'team', ed, body: req.body }); if (mg.error) { modelErr = mg.error; } else { grid = mg.grid; costUsd = mg.costUsd; source = 'model'; coverage = mg.coverage ? { ...mg.coverage, note: mg.note } : null; } }
      else { const text = readTextFile(f); if (text === null) return res.status(400).json({ message: 'בלשונית צוות נקראים רק קבצי xlsx, docx עם טבלה או CSV. קובץ PDF או תמונה חייבים להיות קובץ תקין שנשלח עם אישור, וקבצי xls או doc ישנים: שמרו בפורמט חדש.' }); const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()); const d = [',', ';', '\t'].map((x) => [x, lines[0] ? lines[0].split(x).length : 0]).sort((a, b) => b[1] - a[1])[0][0]; grid = lines.map((l) => splitLine(l, d)); }
    } catch (e) { if (e.userMessage) return res.status(400).json({ message: e.userMessage }); return res.status(400).json({ message: 'לא ניתן לקרוא את הקובץ.' }); }
    if (modelErr) return res.status(modelErr.status).json(modelErr.body);
    const edr = applyFileEdits(grid, ed); if (edr.error) return res.status(400).json({ message: edr.error }); grid = edr.grid;
    const { actions, rejected } = teamRowsFromGrid(grid, branches, problems);
    const docs = actions.length ? await AiProposal.insertMany(actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: 'file:team', expiresAt: new Date(Date.now() + 30 * 60 * 1000) }))) : [];
    logger.info(`ai.team.file user=${req.user._id} proposed=${actions.length} rejected=${rejected.length}`);
    res.json({ summary: `${source === 'model' ? 'המסמך נקרא בעזרת Claude. בדקו כל שורה מול המסמך המקורי. ' : ''}נמצאו ${actions.length} משתמשים להוספה. כל משתמש דורש סיסמה ואישור בנפרד:`, actions: actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), rejected, branches: branches.map((b) => ({ id: String(b._id), name: b.name })), source, costUsd, coverage, fileReview: edr.review });
  }));
  return router;
};
