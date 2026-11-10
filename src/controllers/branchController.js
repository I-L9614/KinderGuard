import Branch from '../models/Branch.js';
import License from '../models/License.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import { deleteFileFromS3 } from '../services/s3Service.js';
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

// Deletes one stored document for a license with durable intent:
// the key is written to pendingFileDeletion BEFORE the destructive storage
// call, so a crash or later failure never loses the key, and a retry treats a
// license with pendingFileDeletion as already cleaned (DeleteObject is
// idempotent on a missing key). Returns true when the document is gone.
const deleteLicenseDocument = async (license, branchId) => {
  if (!license.fileUrl) return true;
  if (license.pendingFileDeletion) {
    // A previous attempt already deleted this object; just clear the reference.
    license.fileUrl = '';
    license.fileName = '';
    license.pendingFileDeletion = '';
    await license.save();
    return true;
  }
  license.pendingFileDeletion = license.fileUrl;
  try {
    await license.save();
  } catch (error) {
    logger.error(`Branch ${branchId} delete: failed to record deletion intent for ${license.fileUrl}: ${error.message}`);
    return false; // nothing destructive happened; the permit is fully intact
  }
  try {
    await deleteFileFromS3(license.pendingFileDeletion);
  } catch (error) {
    logger.error(`Branch ${branchId} delete: storage delete failed for ${license.pendingFileDeletion}: ${error.message}`);
    license.pendingFileDeletion = '';
    await license.save().catch((saveError) => logger.error(`Branch ${branchId} delete: failed to roll back deletion intent on ${license._id}: ${saveError.message}`));
    return false; // permit keeps its document link; retry is safe
  }
  license.fileUrl = '';
  license.fileName = '';
  const key = license.pendingFileDeletion;
  license.pendingFileDeletion = '';
  try {
    await license.save();
  } catch (error) {
    // Reference could not be persisted as cleared. The durable intent key keeps
    // this recoverable: the next attempt sees pendingFileDeletion and clears it.
    license.pendingFileDeletion = key;
    logger.error(`Branch ${branchId} delete: failed to clear file reference on ${license._id}: ${error.message}`);
    return false;
  }
  return true;
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

  const releaseGuard = () => Branch.updateOne({ _id: branch._id }, { $set: { deleting: false } });

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
      if (!(await deleteLicenseDocument(license, branch._id))) { failed = true; break; }
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
    const reason = failed ? 'תקלת אחסון או מסד נתונים' : 'הסניף השתנה בזמן המחיקה';
    return res.status(502).json({ message: `${reason}: המחיקה לא הושלמה (נמחקו ${deletedLicenses} אישורים, נותרו ${remaining}). הסניף לא נמחק - נסו שוב כדי להשלים.` });
  }

  await Notification.deleteMany({ branchId: branch._id });
  await User.updateMany({ adminId }, { $pull: { accessibleBranches: branch._id } });
  await branch.deleteOne();

  // Sweep permits that raced past the guard's creation check and landed while
  // the cascade ran. A permit created after this sweep cannot validate its
  // branch (it no longer exists), so this bounds the race.
  const stragglers = await License.find({ branchId: branch._id });
  for (const straggler of stragglers) {
    if (straggler.fileUrl) {
      try { await deleteFileFromS3(straggler.fileUrl); }
      catch (error) { logger.error(`Branch ${branch._id} delete: sweep could not delete ${straggler.fileUrl}: ${error.message}`); }
    }
    await Notification.deleteMany({ licenseId: straggler._id });
    await straggler.deleteOne();
    deletedLicenses += 1;
  }

  res.json({ ok: true, deletedLicenses });
};
