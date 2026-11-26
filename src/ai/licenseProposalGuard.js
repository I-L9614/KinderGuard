import crypto from 'crypto';
import AiProposal from '../models/AiProposal.js';
import logger from '../utils/logger.js';
import { canUseAi } from './aiAccess.js';
import AiAudit from '../models/AiAudit.js';
import { getAdminId } from '../utils/access.js';
import Branch from '../models/Branch.js';

// Runs before POST /api/licenses. A request without aiProposalId is the normal manual save and is
// untouched. A request that carries one is an AI-assisted save and must pass server checks: the
// proposal belongs to the caller, is unexpired and unused, the uploaded file is byte-identical to the
// file the AI read (sha256), and the user confirmed. The claim is atomic (one save per proposal).
// The audit keeps what the AI proposed next to what the user finally saved.
export const licenseProposalGuard = async (req, res, next) => {
  const id = req.body?.aiProposalId;
  if (!id) return next();
  if (!canUseAi(req.user)) return res.status(403).json({ message: 'אין לכם הרשאה להשתמש בעוזר ה-AI.' });
  if (!/^[a-f\d]{24}$/i.test(String(id))) return res.status(400).json({ message: 'הצעת ה-AI לא תקינה.' });
  if (req.body.aiConfirmed !== 'true') return res.status(400).json({ message: 'יש לאשר שהפרטים נבדקו מול המסמך.' });
  if (!req.file) return res.status(400).json({ message: 'הצעת ה-AI מתייחסת למסמך שצורף. צרפו את אותו מסמך.' });
  const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const doc = await AiProposal.findOneAndUpdate({ _id: id, userId: req.user._id, kind: 'license_fill', status: 'pending', fileSha256: sha, expiresAt: { $gt: new Date() } }, { status: 'executing', confirmedAt: new Date(), final: { licenseTypeId: req.body.licenseTypeId, branchId: req.body.branchId, issueDate: req.body.issueDate, expiryDate: req.body.expiryDate } }, { new: true });
  if (!doc) return res.status(409).json({ message: 'הצעת ה-AI לא תואמת את המסמך, פגה או כבר נוצלה. קראו את המסמך מחדש.' });
  // The proposal status is settled BEFORE the response is flushed (end is held until the update returns), so a client that
  // sees the 201 can never read an 'executing' proposal, and a failed save is back to pending before the client can retry.
  const realEnd = res.end.bind(res); let ending = false;
  res.end = (...args) => {
    if (ending) return realEnd(...args); ending = true;
    const code = res.statusCode; const okNow = code < 400;
    AiProposal.updateOne({ _id: doc._id }, okNow ? { status: 'done', result: { statusCode: code } } : { status: 'pending', lastError: `save failed ${code}` }).catch(() => {}).finally(() => realEnd(...args));
    return res;
  };
  res.on('finish', () => {
    const ok = res.statusCode < 400;
    // Durable audit of the AI-assisted save (best effort, never changes the save outcome). Labels only, no payload.
    // The label is read from our own Branch record (scoped to this account), never taken from the client.
    (async () => { const adminId = getAdminId(req.user); const id = String(req.body?.branchId || ''); const b = /^[a-f\d]{24}$/i.test(id) ? await Branch.findOne({ _id: id, adminId }).select('name').lean() : null; await AiAudit.create({ adminId, userId: req.user._id, proposalId: doc._id, type: 'license_fill_save', label: String(b?.name || '').slice(0, 200), outcome: ok ? 'done' : 'failed', reason: ok ? '' : `save failed ${res.statusCode}` }); })().catch((e) => logger.warn(`ai.audit.write_failed ${String(e.message).slice(0, 120)}`));
    logger.info(`ai.license.save user=${req.user._id} proposal=${doc._id} ok=${ok}`);
  });
  return next();
};
