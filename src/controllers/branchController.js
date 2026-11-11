import Branch from '../models/Branch.js';
import License from '../models/License.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import BranchDeletion from '../models/BranchDeletion.js';
import RentAgreement from '../models/RentAgreement.js';
import Authority from '../models/Authority.js';
import { deleteLicenseDocument } from '../services/licenseCleanup.js';
import { getAdminId } from '../utils/access.js';

export const getBranches = async (req, res) => {
  const filter = { adminId: getAdminId(req.user) };
  if (req.user.role === 'Manager') filter._id = { $in: req.user.accessibleBranches };
  const branches = await Branch.find(filter).populate('authorityId', 'name type').sort({ name: 1 });
  res.json(branches);
};

const toEmailList = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[;,\n]/).map((v) => v.trim()).filter(Boolean);
};

const branchFields = async (body, adminId) => {
  const fields = {};
  for (const key of ['name', 'address', 'maxChildren', 'status', 'managerName', 'phone']) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  if (body.emails !== undefined) fields.emails = toEmailList(body.emails);
  if (body.authorityId !== undefined) {
    if (!body.authorityId) {
      fields.authorityId = null;
    } else {
      const owned = await Authority.exists({ _id: body.authorityId, adminId });
      if (!owned) throw Object.assign(new Error('גוף התשלום לא נמצא'), { status: 400 });
      fields.authorityId = body.authorityId;
    }
  }
  return fields;
};

export const createBranch = async (req, res) => {
  const adminId = getAdminId(req.user);
  const branch = await Branch.create({ adminId, ...await branchFields(req.body, adminId) });
  res.status(201).json(branch);
};

export const updateBranch = async (req, res) => {
  const adminId = getAdminId(req.user);
  const branch = await Branch.findOne({ _id: req.params.id, adminId });
  if (!branch) return res.status(404).json({ message: 'הסניף לא נמצא' });
  Object.assign(branch, await branchFields(req.body, adminId));
  await branch.save();
  res.json(branch);
};

export const deleteBranch = async (req, res) => {
  const adminId = getAdminId(req.user);
  // Atomically claim the branch for deletion so two deletes cannot interleave
  // and so new permits cannot be added once the cascade starts.
  const branch = await Branch.findOneAndUpdate(
    { _id: req.params.id, adminId, deleting: { $ne: true } },
    { $set: { deleting: true } },
    { new: true },
  );
  if (!branch) {
    const exists = await Branch.exists({ _id: req.params.id, adminId });
    return res.status(exists ? 409 : 404).json({ message: exists ? 'מחיקת הסניף כבר מתבצעת. נסו שוב בעוד רגע.' : 'הסניף לא נמצא' });
  }

  // Durable evidence of this confirmed deletion: lets scheduled recovery finish
  // exactly this branch's leftovers if the process dies mid-cascade, and nothing else.
  const releaseGuard = () => Branch.updateOne({ _id: branch._id }, { $set: { deleting: false } });
  try {
    await BranchDeletion.findOneAndUpdate({ branchId: branch._id }, { $set: { adminId } }, { upsert: true });
  } catch (error) {
    await releaseGuard();
    throw error;
  }
  const dropOperation = () => BranchDeletion.deleteOne({ branchId: branch._id });

  // Financial history is never silently erased: a branch with active rent
  // agreements cannot be deleted. Checked after the guard is claimed, and
  // agreement creation is blocked while deleting, so no new agreement can
  // slip in after this check (a raced insert is closed by reconciliation).
  const activeAgreements = await RentAgreement.countDocuments({ branchId: branch._id, status: 'Active' });
  if (activeAgreements > 0) {
    await releaseGuard();
    await dropOperation();
    return res.status(409).json({ message: `לסניף יש ${activeAgreements} הסכמי שכירות פעילים. סגרו את ההסכמים במסך השכירות לפני מחיקת הסניף - היסטוריית התשלומים נשמרת.` });
  }

  // Confirmed cascade: the branch's permits (with history), attached documents
  // and related alerts go with it. Bounded rounds also absorb permits that were
  // created just before the guard was claimed.
  const MAX_ROUNDS = 3;
  let deletedLicenses = 0;
  let failed = false;

  for (let round = 0; round < MAX_ROUNDS && !failed; round += 1) {
    const licenses = await License.find({ branchId: branch._id });
    if (!licenses.length) break;
    for (const license of licenses) {
      if (!(await deleteLicenseDocument(license, `Branch ${branch._id} delete:`))) { failed = true; break; }
      try {
        await Notification.deleteMany({ licenseId: license._id });
        await license.deleteOne();
        deletedLicenses += 1;
      } catch (error) {
        // Its document reference is already cleared and persisted, so the
        // permit we keep never links to a missing file. Stop and report.
        logger.error(`Branch ${branch._id} delete: DB delete failed for license ${license._id}: ${error.message}`);
        failed = true;
        break;
      }
    }
  }

  const remaining = await License.countDocuments({ branchId: branch._id });
  if (failed || remaining > 0) {
    await releaseGuard();
    await dropOperation(); // deletion aborted: no recovery claim on live data
    const reason = failed ? 'תקלת אחסון או מסד נתונים' : 'הסניף השתנה בזמן המחיקה';
    return res.status(502).json({ message: `${reason}: המחיקה לא הושלמה (נמחקו ${deletedLicenses} אישורים, נותרו ${remaining}). הסניף לא נמחק - נסו שוב כדי להשלים.` });
  }

  await Notification.deleteMany({ branchId: branch._id });
  await User.updateMany({ adminId }, { $pull: { accessibleBranches: branch._id } });
  await branch.deleteOne();

  // Sweep permits that raced past the guard's creation check and landed while
  // the cascade ran. A permit created after this sweep cannot validate its
  // branch (it no longer exists), so this bounds the race.
  let sweepPending = 0;
  const stragglers = await License.find({ branchId: branch._id });
  for (const straggler of stragglers) {
    if (!(await deleteLicenseDocument(straggler, `Branch ${branch._id} delete sweep:`))) {
      logger.error(`Branch ${branch._id} delete: sweep kept license ${straggler._id} for deletion recovery`);
      sweepPending += 1;
      continue; // recorded operation lets recovery finish exactly this branch; key stays durable
    }
    await Notification.deleteMany({ licenseId: straggler._id });
    await straggler.deleteOne();
    deletedLicenses += 1;
  }
  // The operation evidence is kept PERMANENTLY for a deleted branch: a permit
  // upload that was already in flight when the guard landed can still insert
  // after this request ends, and the scheduled reconciliation only ever reaps
  // leftovers of recorded operations. Dropping it now could orphan such a write.
  res.json({ ok: true, deletedLicenses });
};
