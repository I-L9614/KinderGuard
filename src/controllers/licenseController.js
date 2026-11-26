import License from '../models/License.js';
import Branch from '../models/Branch.js';
import LicenseType from '../models/LicenseType.js';
import Notification from '../models/Notification.js';
import { getAdminId, hasBranchAccess } from '../utils/access.js';
import { uploadFileToS3, downloadFileFromS3, deleteFileFromS3 } from '../services/s3Service.js';
import { daysUntil } from '../utils/israelTime.js';
import { ALLOWED_UPLOAD_MIME, matchesDeclaredType } from '../utils/uploadTypes.js';
import { activeUniqueIndexPresent } from '../utils/licenseIndex.js';

export const statusForExpiry = (expiryDate) => {
  const days = daysUntil(expiryDate);
  if (days < 0) return 'Expired';
  if (days <= 30) return 'Expiring_Soon';
  return 'Valid';
};

const RENEWAL_REQUIRED_MESSAGE = 'כבר קיים אישור פעיל מסוג זה לסניף. אם זו התחדשות, אשרו במפורש שהאישור הקיים מוחלף בחדש.';
const renewalRequiredBody = (existing) => ({
  code: 'renewal_required',
  message: RENEWAL_REQUIRED_MESSAGE,
  ...(existing ? { existing: { id: String(existing._id), issueDate: existing.issueDate, expiryDate: existing.expiryDate, fileName: existing.fileName || '' } } : {}),
});

export const MANUAL_NO_INDEX_MESSAGE = 'יצירת אישורים לא זמינה כרגע: חסרה הגנה במסד הנתונים מפני שני אישורים פעילים לאותו סניף וסוג. לא נוצר דבר.';

export const createLicense = async (req, res) => {
  const { branchId, licenseTypeId, issueDate, expiryDate, deleteOldFile, confirmRenewal, renewalOf } = req.body;
  // Same fail-closed fence as the AI routes: without the live unique index, a concurrency race could
  // create a second Active approval, a silent replace no one approved. The schema declaration is not
  // evidence (autoIndex can be off); the live index list is read on every creation.
  if (!(await activeUniqueIndexPresent())) return res.status(503).json({ message: MANUAL_NO_INDEX_MESSAGE });
  const branch = await Branch.findById(branchId);
  if (!hasBranchAccess(req.user, branch)) return res.status(branch ? 403 : 404).json({ message: 'אין גישה לסניף שנבחר' });
  if (branch.deleting) return res.status(409).json({ message: 'הסניף בתהליך מחיקה. נסו שוב בעוד רגע.' });
  const licenseType = await LicenseType.findOne({ _id: licenseTypeId, adminId: getAdminId(req.user), active: true, $or: [{ branchId: null }, { branchId }] });
  if (!licenseType) return res.status(400).json({ message: 'סוג האישור אינו זמין לסניף שנבחר' });
  if (new Date(expiryDate) < new Date(issueDate)) return res.status(400).json({ message: 'תאריך הפקיעה חייב להיות אחרי תאריך ההנפקה' });

  // Renewal gate: an Active approval for this branch+type is replaced ONLY after the
  // client explicitly confirms the renewal (confirmRenewal) of the exact record it
  // reviewed (renewalOf, enforced when sent). Without the confirmation the request is
  // refused BEFORE any upload or mutation, with the existing record's details so the
  // client can present the choice. A silent replace is never possible.
  const existing = await License.findOne({ branchId, licenseTypeId, lifecycle: 'Active' }).select('issueDate expiryDate fileName').lean();
  const wantsRenewal = confirmRenewal === true || confirmRenewal === 'true';
  if (existing && !wantsRenewal) return res.status(409).json(renewalRequiredBody(existing));
  if (existing && renewalOf && String(existing._id) !== String(renewalOf)) {
    return res.status(409).json({ code: 'renewal_conflict', message: 'האישור הקיים השתנה מאז שהוזנו הפרטים. רעננו ובדקו שוב לפני החידוש.' });
  }

  let fileKey = '';
  if (req.file) {
    // The declared mimetype passed the route whitelist; now prove the bytes
    // match it, so a renamed script can't ride into storage as a "document".
    if (!matchesDeclaredType(req.file.buffer, req.file.mimetype)) {
      const error = new Error('תוכן הקובץ אינו תואם את סוג הקובץ. העלו PDF או תמונה תקינים.');
      error.statusCode = 400;
      error.publicMessage = error.message;
      throw error;
    }
    try {
      fileKey = await uploadFileToS3(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (error) {
      error.statusCode = 502;
      error.publicMessage = 'המסמך לא הועלה לאחסון. בדקו את החיבור ונסו שוב.';
      throw error;
    }
  }
  // The replace claim is pinned to the exact record the client confirmed. If it is
  // no longer the Active one, a concurrent renewal won and this request refuses
  // instead of replacing a record the user never reviewed.
  const previous = existing
    ? await License.findOneAndUpdate(
      { _id: existing._id, lifecycle: 'Active' },
      { $set: { lifecycle: 'Replaced' } },
      { new: false },
    )
    : null;
  if (existing && !previous) {
    if (fileKey) await deleteFileFromS3(fileKey).catch(() => {});
    return res.status(409).json({ code: 'renewal_conflict', message: 'האישור הקיים חודש או שונה בינתיים. רעננו ובדקו שוב לפני החידוש.' });
  }
  let license;
  try {
    license = await License.create({ branchId, licenseTypeId, issueDate, expiryDate, fileUrl: fileKey, fileName: req.file?.originalname || '', status: statusForExpiry(expiryDate), createdBy: req.user._id });
  } catch (error) {
    if (previous && !(await License.exists({ branchId, licenseTypeId, lifecycle: 'Active' }))) {
      await License.updateOne({ _id: previous._id, lifecycle: 'Replaced', replacedBy: null }, { $set: { lifecycle: 'Active' } });
    }
    // The freshly uploaded document belongs to a creation that failed: drop
    // it from storage instead of leaking an unreferenced object.
    if (fileKey) await deleteFileFromS3(fileKey).catch(() => {});
    // A second creation racing past the gate: the partial unique index picks the
    // single Active winner. The loser converges to the same explicit-approval path
    // as a sequential renewal, with the winner's details for the confirmation.
    if (error && error.code === 11000) {
      const now = await License.findOne({ branchId, licenseTypeId, lifecycle: 'Active' }).select('issueDate expiryDate fileName').lean();
      return res.status(409).json(renewalRequiredBody(now));
    }
    throw error;
  }
  // The type was verified active before the create; a deactivation landing in
  // between must not leave a new approval on a type the admin just removed.
  // Re-read and unwind deterministically: drop the new approval and restore
  // the replaced one exactly like a creation failure.
  if (!(await LicenseType.exists({ _id: licenseTypeId, active: true }))) {
    await License.deleteOne({ _id: license._id });
    if (previous && !(await License.exists({ branchId, licenseTypeId, lifecycle: 'Active' }))) {
      await License.updateOne({ _id: previous._id, lifecycle: 'Replaced', replacedBy: null }, { $set: { lifecycle: 'Active' } });
    }
    if (fileKey) await deleteFileFromS3(fileKey).catch(() => {});
    return res.status(409).json({ message: 'סוג האישור הושבת בינתיים. האישור לא נוצר.' });
  }
  if (previous) {
    await License.updateOne({ _id: previous._id }, { $set: { replacedBy: license._id } });
    await Notification.updateMany({ licenseId: previous._id, status: { $in: ['Open', 'In_Progress'] } }, { status: 'Resolved', resolvedAt: new Date(), resolvedBy: req.user._id });
    // Deleting the replaced approval's document is an explicit user choice
    // (deleteOldFile), never automatic: without it the file stays available
    // from the history view.
    if (previous.fileUrl && (deleteOldFile === true || deleteOldFile === 'true')) {
      try {
        // Reference first, storage after (the durable-intent order of
        // deleteLicenseFile): a storage failure never leaves the history
        // entry pointing at a deleted object - the intent is retried by
        // reconcilePendingFileDeletions.
        const cleared = await License.updateOne({ _id: previous._id, fileUrl: previous.fileUrl }, { $set: { fileUrl: '', fileName: '', pendingFileDeletion: previous.fileUrl } });
        if (cleared.modifiedCount) {
          await deleteFileFromS3(previous.fileUrl);
          await License.updateOne({ _id: previous._id, pendingFileDeletion: previous.fileUrl }, { $set: { pendingFileDeletion: '' } });
        }
      } catch (error) {
        // A storage cleanup failure must not roll back the renewal; the old
        // file simply stays available and can be deleted later.
        console.error('Failed to delete replaced license file:', error.message);
      }
    }
  }
  res.status(201).json(await license.populate('licenseTypeId', 'name'));
};

// Removes only the attached document of an existing approval: the approval
// itself, its dates and its history stay untouched.
export const deleteLicenseFile = async (req, res) => {
  const license = await License.findById(req.params.id);
  const branch = license && await Branch.findById(license.branchId);
  if (!license || !hasBranchAccess(req.user, branch)) return res.status(404).json({ message: 'האישור לא נמצא' });
  if (!license.fileUrl) return res.status(404).json({ message: 'לא נמצא קובץ מצורף לאישור זה' });
  // Conditional commit FIRST, pinned to the exact version and file we loaded
  // (or the proposed version on the AI path): the reference is cleared and the
  // durable deletion intent recorded in one atomic write. A concurrent renewal
  // or second delete misses the filter instead of deleting a wrong/replaced
  // file, and a later storage failure can never leave a dangling reference.
  const cleared = await License.updateOne(
    { _id: license._id, fileUrl: license.fileUrl, updatedAt: req.expectedUpdatedAt || license.updatedAt },
    { $set: { fileUrl: '', fileName: '', pendingFileDeletion: license.fileUrl } },
  );
  if (!cleared.modifiedCount) {
    const current = await License.findById(license._id).select('fileUrl');
    if (current && !current.fileUrl) return res.status(404).json({ message: 'לא נמצא קובץ מצורף לאישור זה' });
    const message = req.expectedUpdatedAt ? 'האישור השתנה מאז ההצעה. בקשו הצעה חדשה.' : 'האישור השתנה בינתיים. רעננו ונסו שוב.';
    return res.status(409).json({ message });
  }
  // The approval no longer references the object; storage cleanup runs after
  // the commit. A failure leaves the durable intent for the hourly
  // reconcilePendingFileDeletions sweep instead of a broken download link -
  // and the response must say so: reference removed is not storage erased.
  let storagePending = false;
  try {
    await deleteFileFromS3(license.fileUrl);
    await License.updateOne({ _id: license._id, pendingFileDeletion: license.fileUrl }, { $set: { pendingFileDeletion: '' } });
  } catch (error) {
    storagePending = true;
    console.error(`License file deletion pending storage retry for ${license.fileUrl}:`, error.message);
  }
  res.json({ message: storagePending ? 'הקישור לקובץ הוסר. מחיקת הקובץ מהאחסון תושלם ברקע.' : 'המסמך נמחק', referenceRemoved: true, storagePending });
};

export const getLicenses = async (req, res) => {
  const filter = { lifecycle: req.query.history === 'true' ? 'Replaced' : 'Active' };
  const branchFilter = { adminId: getAdminId(req.user) };
  if (req.user.role === 'Manager') {
    // A branch user may only ever list permits of his assigned branches: a
    // requested branchId narrows that scope, never widens it.
    const allowed = (req.user.accessibleBranches || []).map(String);
    if (req.query.branchId && !allowed.includes(String(req.query.branchId))) return res.json([]);
    branchFilter._id = req.query.branchId || { $in: req.user.accessibleBranches };
  } else if (req.query.branchId) {
    branchFilter._id = req.query.branchId;
  }
  const branches = await Branch.find(branchFilter).select('_id');
  filter.branchId = { $in: branches.map((b) => b._id) };
  const licenses = await License.find(filter).sort({ expiryDate: 1 }).populate('branchId', 'name').populate('licenseTypeId', 'name').populate('replacedBy', 'issueDate expiryDate');
  res.json(licenses);
};

export const getLicenseHistory = async (req, res) => {
  const license = await License.findById(req.params.id);
  const branch = license && await Branch.findById(license.branchId);
  if (!license || !hasBranchAccess(req.user, branch)) return res.status(404).json({ message: 'האישור לא נמצא' });
  const all = await License.find({ branchId: license.branchId, licenseTypeId: license.licenseTypeId }).sort({ issueDate: -1 }).populate('licenseTypeId', 'name');
  res.json(all);
};

export const downloadLicenseFile = async (req, res) => {
  const license = await License.findById(req.params.id);
  const branch = license && await Branch.findById(license.branchId);
  if (!license || !hasBranchAccess(req.user, branch)) return res.status(404).json({ message: 'האישור לא נמצא' });
  if (!license.fileUrl) return res.status(404).json({ message: 'לא נמצא קובץ מצורף לאישור זה' });

  let s3Response;
  try {
    s3Response = await downloadFileFromS3(license.fileUrl);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ message: 'הקובץ לא נמצא באחסון. ייתכן שהוא הוסר.' });
    }
    error.statusCode = 502;
    error.publicMessage = 'שירות האחסון אינו זמין כרגע. נסו שוב בעוד רגע.';
    throw error;
  }

  const fileName = license.fileName || 'license-file';
  const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  // Only known document/image types render inline. Anything else (a legacy or
  // manually planted object) downloads as an opaque attachment, never as an
  // active page on our origin.
  const storedType = s3Response.ContentType || 'application/octet-stream';
  const safeInline = ALLOWED_UPLOAD_MIME.has(storedType);
  res.setHeader('Content-Type', safeInline ? storedType : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (s3Response.ContentLength) res.setHeader('Content-Length', String(s3Response.ContentLength));
  s3Response.Body.pipe(res);
};

export const refreshLicenseStatuses = async () => {
  const licenses = await License.find({ lifecycle: 'Active' });
  for (const license of licenses) {
    const status = statusForExpiry(license.expiryDate);
    if (license.status !== status) { license.status = status; await license.save(); }
  }
};

export const deleteLicense = async (req, res) => {
  const license = await License.findById(req.params.id);
  const branch = license && await Branch.findById(license.branchId);
  if (!license || !hasBranchAccess(req.user, branch)) return res.status(404).json({ message: 'האישור לא נמצא' });
  if (req.expectedUpdatedAt) {
    // AI path: conditional at the database on the proposed version.
    const r = await License.updateOne({ _id: license._id, lifecycle: 'Active', updatedAt: req.expectedUpdatedAt }, { $set: { lifecycle: 'Replaced' } });
    if (!r.modifiedCount) return res.status(409).json({ message: 'האישור השתנה מאז ההצעה. בקשו הצעה חדשה.' });
  } else {
    license.lifecycle = 'Replaced';
    await license.save();
  }
  await Notification.updateMany({ licenseId: license._id, status: { $in: ['Open', 'In_Progress'] } }, { status: 'Resolved', resolvedAt: new Date(), resolvedBy: req.user._id });
  res.json({ message: 'האישור הועבר לארכיון' });
};
