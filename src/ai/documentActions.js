import crypto from 'crypto';
import express from 'express';
import { protect, authorizeRoles } from '../middleware/authMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { documentUpload } from '../middleware/upload.js';
import { matchesDeclaredType } from '../utils/uploadTypes.js';
import RentAgreement from '../models/RentAgreement.js';
import Branch from '../models/Branch.js';
import Authority from '../models/Authority.js';
import { getAdminId } from '../utils/access.js';
import { uploadAgreementDocument } from '../controllers/rentController.js';
import { downloadFileFromS3 } from '../services/s3Service.js';
import logger from '../utils/logger.js';
import AiAudit from '../models/AiAudit.js';
import { requireAiAccess } from './aiAccess.js';

// Rent-agreement document intake. NO model call and no provider exposure: the file is never sent to Claude.
// The server stores only the file's sha256, name and size plus the candidate agreements. The user must pick the
// destination agreement explicitly on the card (never preselected, a filename match is only a hint). The confirm
// re-sends the same bytes (sha256 must match) and calls the existing upload controller with the agreement's
// version, so a changed agreement is refused with 409 and the document is saved to exactly the reviewed one.
// Durable audit of a confirmed upload (best effort, never changes the outcome). Label is the file name only.
const auditUpload = (req, doc, outcome, reason = '') => AiAudit.create({ adminId: getAdminId(req.user), userId: req.user._id, proposalId: doc._id, type: 'upload_agreement_document', label: String(doc.action?.fileName || '').slice(0, 200), outcome, reason: String(reason).slice(0, 200) }).catch((e) => logger.warn(`ai.audit.write_failed ${String(e.message).slice(0, 120)}`));
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const norm = (v) => String(v || '').toLowerCase().replace(/[\s_\-.]+/g, ' ');
const MAX_CANDIDATES = 60;
const MAX_HASH_READS = 6;
const readAll = async (body) => { const chunks = []; for await (const c of body) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
// Content-hash duplicate check. A stored sha256 settles it for files saved through the AI worker. A same-named older file
// without a hash is downloaded and hashed (bounded reads), then other unhashed files while the read budget lasts. Files beyond the budget are reported as unchecked.
export const markIdenticalDocuments = async (sha, agreements, candidates, readStored = async (key) => (await readAll((await downloadFileFromS3(key)).Body))) => {
  let reads = 0; const f = (name) => norm(name);
  for (const c of candidates) {
    const a = agreements.find((x) => String(x._id) === c.id); const docs = a?.documents || []; c.identical = false; c.identicalUnchecked = false;
    if (docs.some((d) => d.sha256 && d.sha256 === sha)) { c.identical = true; continue; }
    // Unhashed stored files are hashed from storage, same-named ones first, within one bounded read budget per request. Whatever is left
    // unread is reported as unchecked on the candidate (never silently treated as different).
    if (docs.some((d) => !d.sha256 && !d.key)) c.identicalUnchecked = true; // stored file with no hash and no storage key: cannot be verified
    const unhashed = docs.filter((d) => !d.sha256 && d.key).sort((x, y) => Number(f(y.fileName) === c.__f) - Number(f(x.fileName) === c.__f));
    for (const d of unhashed) {
      if (reads >= MAX_HASH_READS) { c.identicalUnchecked = true; continue; }
      reads += 1; try { const buf = await readStored(d.key); if (crypto.createHash('sha256').update(buf).digest('hex') === sha) { c.identical = true; break; } } catch { c.identicalUnchecked = true; }
    }
  }
  for (const c of candidates) delete c.__f;
  return candidates;
};

export const buildDocumentCandidates = (fileName, agreements) => {
  const f = norm(fileName);
  return agreements.map((a) => {
    const hit = [a.branchName, a.authorityName].filter((x) => x && f.includes(norm(x)));
    return {
      id: String(a._id), branchName: a.branchName, authorityName: a.authorityName, version: new Date(a.updatedAt).toISOString(),
      __f: f, suggested: hit.length > 0, sameName: (a.documents || []).some((d) => d.fileName && norm(d.fileName) === f), documentCount: (a.documents || []).length,
    };
  });
};

import { disambiguateAgreements, agreementDetail } from './candidateDetails.js';
export const createDocumentActionsRouter = ({ AiProposal }) => {
  const router = express.Router();
  const guard = [asyncHandler(protect), authorizeRoles('Admin'), requireAiAccess];
  router.post('/agreements/document/propose', ...guard, documentUpload.single('file'), asyncHandler(async (req, res) => {
    const f = req.file;
    if (!f || !matchesDeclaredType(f.buffer, f.mimetype)) return res.status(400).json({ message: 'יש לצרף קובץ PDF או תמונה תקינים.' });
    const adminId = getAdminId(req.user);
    const list = await RentAgreement.find({ adminId, status: 'Active' }).sort({ updatedAt: -1 }).limit(MAX_CANDIDATES).lean();
    if (!list.length) return res.status(404).json({ message: 'אין הסכמי שכירות פעילים לשיוך המסמך.' });
    const [bs, as] = await Promise.all([Branch.find({ _id: { $in: list.map((x) => x.branchId) } }).select('name address managerName').lean(), Authority.find({ _id: { $in: list.map((x) => x.authorityId) } }).select('name').lean()]);
    const bn = new Map(bs.map((b) => [String(b._id), b.name])); const an = new Map(as.map((x) => [String(x._id), x.name]));
    const candidates = buildDocumentCandidates(f.originalname, list.map((x) => ({ ...x, branchName: bn.get(String(x.branchId)) || '', authorityName: an.get(String(x.authorityId)) || '' })));
    // Preselect only: the agreement the user just created in this session, if it is among the caller's own active agreements. The user still confirms the destination.
    if (/^[a-f\d]{24}$/i.test(String(req.body?.prefer || ''))) { const pc = candidates.find((c) => c.id === String(req.body.prefer)); if (pc) pc.preferred = true; }
    const dErr = disambiguateAgreements(candidates, list, new Map(bs.map((b) => [String(b._id), b]))); if (dErr) return res.status(422).json({ message: dErr });
    await markIdenticalDocuments(crypto.createHash('sha256').update(f.buffer).digest('hex'), list, candidates);
    const action = { type: 'upload_agreement_document', domain: 'agreement_document', fileName: String(f.originalname || '').slice(0, 200), size: f.size, candidates };
    const doc = await AiProposal.create({ userId: req.user._id, adminId, action, fileSha256: crypto.createHash('sha256').update(f.buffer).digest('hex'), promptExcerpt: '', expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
    logger.info(`ai.document.propose user=${req.user._id} candidates=${candidates.length}`);
    res.json({ proposalId: String(doc._id), fileName: action.fileName, size: f.size, candidates });
  }));

  // Deletion proposal: built from the user's explicit pick (agreement + document), never from the model. The card is
  // sensitive: it needs the shared step-up grant (ai:delete_agreement_document, scope = proposal id) at confirm.
  router.post('/agreements/document/delete-propose', ...guard, express.json(), asyncHandler(async (req, res) => {
    const { agreementId, docId } = req.body || {};
    if (!/^[a-f\d]{24}$/i.test(String(agreementId)) || !/^[a-f\d]{24}$/i.test(String(docId))) return res.status(400).json({ message: 'בחרו מסמך למחיקה.' });
    const adminId = getAdminId(req.user);
    const ag = await RentAgreement.findOne({ _id: agreementId, adminId, status: { $ne: 'Pending_Setup' } }); // uncommitted guarded creates are not addressable
    const d = ag?.documents.id(docId);
    if (!ag || !d) return res.status(404).json({ message: 'המסמך לא נמצא' });
    const [b, au] = await Promise.all([Branch.findById(ag.branchId).select('name').lean(), Authority.findById(ag.authorityId).select('name').lean()]);
    const action = { type: 'delete_agreement_document', domain: 'agreement', sensitive: true, agreementId: String(ag._id), docId: String(d._id), fileName: d.fileName || '', branchName: b?.name || '', authorityName: au?.name || '', version: new Date(ag.updatedAt).toISOString() };
    const doc = await AiProposal.create({ userId: req.user._id, adminId, action, promptExcerpt: '', expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
    res.json({ summary: '', actions: [{ ...action, proposalId: String(doc._id) }], rejected: [], branches: [] });
  }));

  router.post('/agreements/document/:id/confirm', ...guard, documentUpload.single('file'), asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!/^[a-f\d]{24}$/i.test(id)) return res.status(404).json({ message: 'ההצעה לא נמצאה' });
    const f = req.file;
    if (!f || !matchesDeclaredType(f.buffer, f.mimetype)) return res.status(400).json({ message: 'יש לצרף שוב את אותו הקובץ.' });
    const pre = await AiProposal.findOne({ _id: id, userId: req.user._id, 'action.type': 'upload_agreement_document' });
    if (!pre) return res.status(404).json({ message: 'ההצעה לא נמצאה או שפג תוקפה' });
    if (pre.status === 'done') return res.json({ status: 'done', duplicate: true, result: pre.result });
    if (pre.status === 'executing') return res.status(409).json({ message: 'הפעולה כבר מתבצעת' });
    const choice = (pre.action.candidates || []).find((c) => c.id === String(req.body?.agreementId || ''));
    if (!choice) return res.status(400).json({ message: 'בחרו את ההסכם שאליו לשייך את המסמך.' });
    if (choice.detail) { const lag = await RentAgreement.findOne({ _id: choice.id, adminId: getAdminId(req.user) }).lean(); const lb = lag && await Branch.findOne({ _id: lag.branchId, adminId: getAdminId(req.user) }).select('address managerName').lean(); if (!lag || agreementDetail(lag, lb) !== choice.detail) return res.status(409).json({ message: 'פרטי ההסכם שנבחר (כתובת, מנהל, סכום, תדירות או פרעון ראשון) השתנו מאז ההצעה. התחילו מחדש ובחרו שוב.' }); }
    if (crypto.createHash('sha256').update(f.buffer).digest('hex') !== pre.fileSha256) return res.status(400).json({ message: 'הקובץ שונה מהקובץ שנבדק. התחילו מחדש.' });
    const doc = await AiProposal.findOneAndUpdate({ _id: id, userId: req.user._id, status: 'pending', expiresAt: { $gt: new Date() } }, { status: 'executing', confirmedAt: new Date(), 'action.agreementId': choice.id }, { new: true });
    if (!doc) return res.status(409).json({ message: 'ההצעה כבר טופלה או שפג תוקפה' });
    try {
      let status = 200; let payload; const r2 = { status(c) { status = c; return r2; }, json(v) { payload = v; return r2; } };
      await uploadAgreementDocument({ user: req.user, params: { id: choice.id }, file: f, expectedUpdatedAt: new Date(choice.version) }, r2);
      if (status >= 400) throw fail(status, payload?.message || 'השמירה נכשלה');
      if (payload?._id) await RentAgreement.updateOne({ _id: choice.id, 'documents._id': payload._id }, { $set: { 'documents.$.sha256': pre.fileSha256 } }, { timestamps: false }).catch((e) => logger.warn(`ai.document.hash_not_recorded ${String(e.message).slice(0, 100)}`));
      const result = { agreementId: choice.id, documentId: String(payload?._id || ''), fileName: doc.action.fileName };
      await AiProposal.updateOne({ _id: doc._id }, { status: 'done', result, lastError: '' });
      await auditUpload(req, doc, 'done');
      logger.info(`ai.document.saved user=${req.user._id} proposal=${doc._id}`);
      return res.json({ status: 'done', duplicate: false, result });
    } catch (e) {
      await AiProposal.updateOne({ _id: doc._id }, { status: 'pending', lastError: String(e.message).slice(0, 200) });
      await auditUpload(req, doc, 'failed', e.message);
      return res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : e.publicMessage || 'השמירה נכשלה' });
    }
  }));
  return router;
};
