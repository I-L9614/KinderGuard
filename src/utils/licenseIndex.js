import License from '../models/License.js';

// License creation is only allowed when the REAL live collection carries the partial unique index that stops two Active licenses
// for one branch and type. The schema declaration is not evidence (autoIndex can be off), so the index list is read from the database.
// Shared by the AI routes and the manual POST /api/licenses route: without this fence, a concurrency race can create a second
// Active license, which is a silent replace no one approved.
export const activeUniqueIndexPresent = async () => {
  try {
    const idx = await License.collection.indexes();
    return idx.some((i) => i.unique === true && Object.keys(i.key || {}).length === 2 && i.key.branchId === 1 && i.key.licenseTypeId === 1 && i.partialFilterExpression && Object.keys(i.partialFilterExpression).length === 1 && i.partialFilterExpression.lifecycle === 'Active');
  } catch { return false; }
};
