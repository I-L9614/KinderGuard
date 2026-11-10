import License from '../models/License.js';
import Branch from '../models/Branch.js';
import LicenseType from '../models/LicenseType.js';
import Notification from '../models/Notification.js';
import { getAdminId, hasBranchAccess } from '../utils/access.js';
import { uploadFileToS3 } from '../services/s3Service.js';

export const statusForExpiry = (expiryDate) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate); expiry.setHours(0, 0, 0, 0);
  const days = Math.ceil((expiry - today) / 86400000);
  if (days < 0) return 'Expired';
  if (days <= 30) return 'Expiring_Soon';
  return 'Valid';
};

export const createLicense = async (req, res) => {
  const { branchId, licenseTypeId, issueDate, expiryDate } = req.body;
  const branch = await Branch.findById(branchId);
  if (!hasBranchAccess(req.user, branch)) return res.status(branch ? 403 : 404).json({ message: 'אין גישה לסניף שנבחר' });
  const licenseType = await LicenseType.findOne({ _id: licenseTypeId, adminId: getAdminId(req.user), active: true, $or: [{ branchId: null }, { branchId }] });
  if (!licenseType) return res.status(400).json({ message: 'סוג האישור אינו זמין לסניף שנבחר' });
  if (new Date(expiryDate) < new Date(issueDate)) return res.status(400).json({ message: 'תאריך הפקיעה חייב להיות אחרי תאריך ההנפקה' });

  let fileUrl = '';
  if (req.file) {
    try {
      fileUrl = await uploadFileToS3(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (error) {
      error.statusCode = 502;
      error.publicMessage = 'המסמך לא הועלה לאחסון. בדקו את החיבור ונסו שוב.';
      throw error;
    }
  }
  const previous = await License.findOneAndUpdate(
    { branchId, licenseTypeId, lifecycle: 'Active' },
    { $set: { lifecycle: 'Replaced' } },
    { new: false },
  );
  let license;
  try {
    license = await License.create({ branchId, licenseTypeId, issueDate, expiryDate, fileUrl, fileName: req.file?.originalname || '', status: statusForExpiry(expiryDate), createdBy: req.user._id });
  } catch (error) {
    if (previous && !(await License.exists({ branchId, licenseTypeId, lifecycle: 'Active' }))) {
      await License.updateOne({ _id: previous._id, lifecycle: 'Replaced', replacedBy: null }, { $set: { lifecycle: 'Active' } });
    }
    throw error;
  }
  if (previous) {
    await License.updateOne({ _id: previous._id }, { $set: { replacedBy: license._id } });
    await Notification.updateMany({ licenseId: previous._id, status: { $in: ['Open', 'In_Progress'] } }, { status: 'Resolved', resolvedAt: new Date(), resolvedBy: req.user._id });
  }
  res.status(201).json(await license.populate('licenseTypeId', 'name'));
};

export const getLicenses = async (req, res) => {
  const filter = { lifecycle: req.query.history === 'true' ? 'Replaced' : 'Active' };
  const branchFilter = { adminId: getAdminId(req.user) };
  if (req.user.role === 'Manager') branchFilter._id = { $in: req.user.accessibleBranches };
  if (req.query.branchId) branchFilter._id = req.query.branchId;
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
  license.lifecycle = 'Replaced';
  await license.save();
  await Notification.updateMany({ licenseId: license._id, status: { $in: ['Open', 'In_Progress'] } }, { status: 'Resolved', resolvedAt: new Date(), resolvedBy: req.user._id });
  res.json({ message: 'האישור הועבר לארכיון' });
};
