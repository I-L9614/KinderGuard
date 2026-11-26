import License from '../models/License.js';
import Notification from '../models/Notification.js';
import RentAgreement from '../models/RentAgreement.js';

// What deleting a branch takes with it, counted live. The AI delete card shows this snapshot and the controller
// re-counts it AFTER it has claimed the branch (when no new permit or agreement can start), so the approval is
// bound to exactly what the user saw. Financial history (closed agreements, payments) is never deleted.
export const countBranchDependents = async (branchId) => {
  const [licenses, files, alerts, activeAgreements, closedAgreements] = await Promise.all([
    License.countDocuments({ branchId }),
    License.countDocuments({ branchId, fileUrl: { $ne: '' } }),
    Notification.countDocuments({ branchId }),
    RentAgreement.countDocuments({ branchId, status: 'Active' }),
    // Explicitly Closed only: Pending_Setup rows (uncommitted guarded creates)
    // are neither active nor financial history.
    RentAgreement.countDocuments({ branchId, status: 'Closed' }),
  ]);
  return { licenses, files, alerts, activeAgreements, closedAgreements };
};
export const SNAPSHOT_KEYS = ['licenses', 'files', 'alerts', 'activeAgreements'];
