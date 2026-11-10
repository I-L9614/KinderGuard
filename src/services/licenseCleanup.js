import License from '../models/License.js';
import Notification from '../models/Notification.js';
import Branch from '../models/Branch.js';
import BranchDeletion from '../models/BranchDeletion.js';
import logger from '../utils/logger.js';
import { deleteFileFromS3 } from './s3Service.js';

// Deletes a license's stored document with durable intent. The object key is
// persisted to pendingFileDeletion BEFORE the destructive storage call and is
// never dropped on presence alone: every attempt re-issues DeleteObject with
// the durable key (idempotent on a missing key) and only clears the intent
// after the delete is confirmed AND the cleared reference is persisted.
// Returns true only when no stored document remains for this license.
export const deleteLicenseDocument = async (license, context = '') => {
  const key = license.pendingFileDeletion || license.fileUrl;
  if (!key) return true;

  if (!license.pendingFileDeletion) {
    license.pendingFileDeletion = key;
    try {
      await license.save();
    } catch (error) {
      logger.error(`${context} failed to record deletion intent for ${key}: ${error.message}`);
      return false; // nothing destructive happened; the permit is fully intact
    }
  }

  try {
    await deleteFileFromS3(key);
  } catch (error) {
    // Intent is retained durably; the permit keeps its document link; retry re-attempts.
    logger.error(`${context} storage delete failed for ${key}: ${error.message}`);
    return false;
  }

  license.fileUrl = '';
  license.fileName = '';
  license.pendingFileDeletion = '';
  try {
    await license.save();
  } catch (error) {
    // Persisted doc still carries fileUrl + pendingFileDeletion with the key,
    // so the next attempt re-deletes (idempotent) and clears. Never lost.
    logger.error(`${context} failed to persist cleared reference for ${license._id}: ${error.message}`);
    return false;
  }
  return true;
};

// Converges user-confirmed branch deletions: for each recorded deletion
// operation whose branch is already gone, finish removing its remaining
// permits (with documents and alerts) through the same durable-intent path.
// Operations whose branch still exists were aborted - their evidence record is
// dropped and their data is never touched. Never deletes arbitrary branchless
// licenses: a branchId must come from a recorded, confirmed deletion.
export const reconcileBranchDeletions = async () => {
  const operations = await BranchDeletion.find({});
  let reaped = 0;
  for (const operation of operations) {
    const branch = await Branch.findById(operation.branchId);
    if (branch && branch.deleting) continue; // cascade still running; keep the evidence
    if (branch) {
      await operation.deleteOne(); // aborted deletion; nothing to recover
      continue;
    }
    const leftovers = await License.find({ branchId: operation.branchId });
    for (const leftover of leftovers) {
      if (!(await deleteLicenseDocument(leftover, `Deletion recovery ${operation.branchId}:`))) continue; // key stays durable; next run retries
      await Notification.deleteMany({ licenseId: leftover._id });
      await leftover.deleteOne();
      reaped += 1;
    }
    // Evidence is never dropped for a deleted branch: a delayed in-flight write
    // can land at any later point and only this record lets the next run reap it.
  }
  if (reaped > 0) logger.info(`Deletion recovery removed ${reaped} leftover license(s)`);
  return reaped;
};
