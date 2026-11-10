import User from '../models/User.js';
import Branch from '../models/Branch.js';
import logger from '../utils/logger.js';
import { getAdminId } from '../utils/access.js';
import { issueTokensForUser } from './authController.js';

export const registerUser = async (req, res) => {
  // Public registration is only for the first account. Later users are added by an Admin.
  if (await User.exists({})) return res.status(403).json({ message: 'ההרשמה סגורה. בקשו ממנהל החשבון להוסיף אתכם.' });
  const { name, email, password } = req.body;
  const user = await User.create({ name, email, password, role: 'Admin' });
  user.adminId = user._id;
  await user.save();
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, token: await issueTokensForUser(res, user) });
};

export const createManagedUser = async (req, res) => {
  const { name, email, password, role = 'Manager', accessibleBranches = [] } = req.body;
  if (!['Admin', 'Manager'].includes(role)) return res.status(400).json({ message: 'תפקיד משתמש לא תקין' });
  if (role === 'Admin') return res.status(400).json({ message: 'אפשר להוסיף משתמש מנהל בלבד' });
  if (await User.exists({ email })) return res.status(400).json({ message: 'כתובת הדוא״ל כבר קיימת' });

  const adminId = getAdminId(req.user);
  const branches = await Branch.find({ _id: { $in: accessibleBranches }, adminId });
  if (branches.length !== new Set(accessibleBranches.map(String)).size) {
    return res.status(400).json({ message: 'אחד או יותר מהסניפים שנבחרו אינם שייכים לחשבון' });
  }

  const user = await User.create({ name, email, password, role: 'Manager', adminId, accessibleBranches: branches.map((b) => b._id) });
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, accessibleBranches: user.accessibleBranches });
};

export const listManagedUsers = async (req, res) => {
  const users = await User.find({ adminId: getAdminId(req.user), _id: { $ne: getAdminId(req.user) } }).select('name email role accessibleBranches createdAt').populate('accessibleBranches', 'name');
  res.json(users);
};

export const loginUser = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user || !(await user.comparePassword(password))) {
    logger.warn(`Failed login for email: ${email}`);
    return res.status(401).json({ message: 'כתובת דוא״ל או סיסמה שגויות' });
  }
  res.json({ id: user._id, name: user.name, email: user.email, role: user.role, token: await issueTokensForUser(res, user) });
};

export const getCurrentUser = async (req, res) => {
  const user = req.user.toObject();
  user.adminId = getAdminId(req.user);
  res.json(user);
};
