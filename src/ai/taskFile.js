import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
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
import { sanitizeActions } from './taskActions.js';

// File -> create_task proposals, fully local: no model, no external call. Only xlsx, docx (first table) and csv are read here.
// Every row becomes its own create_task card that the user confirms. Rows that cannot be read exactly are reported, never guessed.
const MAX_ROWS = 20;
const HEAD = { title: ['כותרת', 'משימה', 'שם המשימה', 'title', 'task'], notes: ['הערות', 'תיאור', 'notes', 'description'], dueDate: ['תאריך יעד', 'תאריך', 'יעד', 'due', 'duedate'], branch: ['סניף', 'שם הסניף', 'מעון', 'גן', 'branch'] };
const headKey = (h) => { const n = normName(h); return Object.keys(HEAD).find((k) => HEAD[k].some((x) => normName(x) === n)) || null; };

export const taskRowsFromGrid = (grid, branches, extra = []) => {
  const rejected = [...extra]; const lines = grid.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (lines.length < 2) return { actions: [], rejected: [...rejected, 'הקובץ ריק או בלי שורות נתונים'] };
  const keys = lines[0].map((c) => headKey(String(c ?? '').trim()));
  if (!keys.includes('title')) return { actions: [], rejected: [...rejected, 'לא נמצאה עמודת כותרת משימה (כותרת / משימה)'] };
  if (lines.length - 1 > MAX_ROWS) rejected.push(`נמצאו ${lines.length - 1} שורות. נקראו ${MAX_ROWS} הראשונות, העלו את השאר בנפרד`);
  const raw = [];
  for (const [i, cells] of lines.slice(1, MAX_ROWS + 1).entries()) {
    const r = {}; keys.forEach((k, j) => { if (k) r[k] = String(cells[j] ?? '').trim(); });
    const label = `שורה ${i + 2}`;
    const bad = Object.entries(r).filter(([k, v]) => v && unsafeCell(k, v)).map(([k]) => ({ title: 'כותרת', notes: 'הערות', dueDate: 'תאריך יעד', branch: 'סניף' }[k] || k));
    if (bad.length) { rejected.push(`${label}: ערך שמתחיל בתו חשוד (= + - @) בשדות ${bad.join(', ')}. השורה לא נקלטה`); continue; }
    if (!r.title) { rejected.push(`${label}: חסרה כותרת`); continue; }
    let branchId = null;
    if (r.branch) { const m = branches.filter((b) => normName(b.name) === normName(r.branch)); if (m.length !== 1) { rejected.push(`${label}: הסניף "${r.branch}" ${m.length ? 'לא חד־משמעי' : 'לא נמצא'}. השורה לא נקלטה`); continue; } branchId = String(m[0]._id); }
    if (r.dueDate && !(/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) && (() => { const d = new Date(`${r.dueDate}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === r.dueDate; })())) { rejected.push(`${label}: תאריך "${r.dueDate}" לא תאריך תקין בפורמט שנה-חודש-יום (2026-12-31). השורה לא נקלטה`); continue; }
    raw.push({ type: 'create_task', title: r.title, notes: r.notes || '', dueDate: r.dueDate || null, branchId, _label: label });
  }
  // sanitizeActions takes at most 5 per call, so feed it in chunks: no row is dropped silently.
  const actions = []; const list = raw.map(({ _label, ...a }) => a);
  for (let i = 0; i < list.length; i += 5) { const out = sanitizeActions(JSON.stringify({ actions: list.slice(i, i + 5) }), [], branches); actions.push(...out.actions); rejected.push(...out.rejected); }
  return { actions, rejected };
};

export const createTaskFileRouter = ({ client, AiProposal }) => {
  const router = express.Router();
  router.post('/tasks/file-propose', asyncHandler(protect), requireAiAccess, fileUpload.single('file'), asyncHandler(async (req, res) => {
    const f = req.file; if (!f || !f.buffer?.length) return res.status(400).json({ message: 'צרפו קובץ xlsx, docx עם טבלה או CSV.' });
    const name = f.originalname || ''; const adminId = getAdminId(req.user);
    const bf = req.user.role === 'Admin' ? { adminId } : { adminId, _id: { $in: req.user.accessibleBranches || [] } };
    const branches = await Branch.find(bf).select('name').lean();
    const ed = parseFileEdits(req.body, f); if (ed.error) return res.status(400).json({ message: ed.error });
    let grid; let problems = []; let costUsd = 0; let source = 'local'; let modelErr = null; let coverage = null;
    try {
      if (/\.xlsx$/i.test(name)) { const g = readXlsxFirstSheet(f.buffer); grid = g.rows; problems = g.problems || []; }
      else if (/\.docx$/i.test(name)) { const g = readDocxFirstTable(f.buffer); grid = g.rows; problems = g.problems || []; }
      else if (isModelFile(f)) { const mg = await modelGrid({ client, f, kind: 'tasks', ed, body: req.body }); if (mg.error) { modelErr = mg.error; } else { grid = mg.grid; costUsd = mg.costUsd; source = 'model'; coverage = mg.coverage ? { ...mg.coverage, note: mg.note } : null; } }
      else { const text = readTextFile(f); if (text === null) return res.status(400).json({ message: 'בלשונית משימות נקראים רק קבצי xlsx, docx עם טבלה או CSV. קובץ PDF או תמונה חייבים להיות קובץ תקין שנשלח עם אישור, וקבצי xls או doc ישנים: שמרו בפורמט חדש.' }); const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()); const d = [',', ';', '\t'].map((x) => [x, lines[0] ? lines[0].split(x).length : 0]).sort((a, b) => b[1] - a[1])[0][0]; grid = lines.map((l) => splitLine(l, d)); }
    } catch (e) { if (e.userMessage) return res.status(400).json({ message: e.userMessage }); return res.status(400).json({ message: 'לא ניתן לקרוא את הקובץ.' }); }
    if (modelErr) return res.status(modelErr.status).json(modelErr.body);
    const edr = applyFileEdits(grid, ed); if (edr.error) return res.status(400).json({ message: edr.error }); grid = edr.grid;
    const { actions, rejected } = taskRowsFromGrid(grid, branches, problems);
    const docs = actions.length ? await AiProposal.insertMany(actions.map((action) => ({ userId: req.user._id, adminId, action, promptExcerpt: 'file:tasks', expiresAt: new Date(Date.now() + 30 * 60 * 1000) }))) : [];
    logger.info(`ai.tasks.file user=${req.user._id} proposed=${actions.length} rejected=${rejected.length}`);
    res.json({ summary: `${source === 'model' ? 'המסמך נקרא בעזרת Claude. בדקו כל שורה מול המסמך המקורי. ' : ''}נמצאו ${actions.length} משימות לפתיחה. בדקו לפני אישור:`, actions: actions.map((a, i) => ({ ...a, proposalId: String(docs[i]._id) })), rejected, branches: branches.map((b) => ({ id: String(b._id), name: b.name })), source, costUsd, coverage, fileReview: edr.review });
  }));
  return router;
};
