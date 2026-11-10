import Branch from '../models/Branch.js';
import License from '../models/License.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import BranchDeletion from '../models/BranchDeletion.js';
import { deleteLicenseDocument } from '../services/licenseCleanup.js';
import { getAdminId } from '../utils/access.js';

export const getBranches = async (req, res) => {
  const filter = { adminId: getAdminId(req.user) };
  if (req.user.role === 'Manager') filter._id = { $in: req.user.accessibleBranches };
  const branches = await Branch.find(filter).sort({ name: 1 });
  res.json(branches);
};

export const createBranch = async (req, res) => {
  const { name, address, maxChildren, status } = req.body;
  const branch = await Branch.create({ adminId: getAdminId(req.user), name, address, maxChildren, status });
  res.status(201).json(branch);
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
