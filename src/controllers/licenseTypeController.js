import LicenseType from '../models/LicenseType.js';
import Branch from '../models/Branch.js';
import { getAdminId, hasBranchAccess } from '../utils/access.js';

export const getLicenseTypes = async (req, res) => {
  const filter = { adminId: getAdminId(req.user), active: true };
  if (req.query.branchId) {
    const branch = await Branch.findById(req.query.branchId);
    if (!hasBranchAccess(req.user, branch)) return res.status(404).json({ message: 'הסניף לא נמצא' });
    filter.$or = [{ branchId: null }, { branchId: req.query.branchId }];
  } else if (req.user.role === 'Manager') {
    filter.$or = [{ branchId: null }, { branchId: { $in: req.user.accessibleBranches } }];
  }
  const types = await LicenseType.find(filter).sort({ name: 1 }).populate('branchId', 'name');
  res.json(types);
};

export const createLicenseType = async (req, res) => {
  const { name, description = '', branchId = null } = req.body;
  if (branchId) {
    const branch = await Branch.findOne({ _id: branchId, adminId: getAdminId(req.user) });
    if (!branch) return res.status(400).json({ message: 'הסניף שנבחר אינו קיים בחשבון' });
  }
  const exists = await LicenseType.exists({ adminId: getAdminId(req.user), branchId, name: name.trim() });
  if (exists) return res.status(409).json({ message: 'סוג אישור בשם זה כבר קיים בהיקף שנבחר' });
  const type = await LicenseType.create({ adminId: getAdminId(req.user), name, description, branchId });
  res.status(201).json(type);
};

export const deactivateLicenseType = async (req, res) => {
  const type = await LicenseType.findOne({ _id: req.params.id, adminId: getAdminId(req.user) });
  if (!type) return res.status(404).json({ message: 'סוג האישור לא נמצא' });
  type.active = false;
  await type.save();
  res.json({ message: 'סוג האישור הוסר מהרשימה הפעילה' });
};
