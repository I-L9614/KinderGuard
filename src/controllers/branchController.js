import Branch from '../models/Branch.js';
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
