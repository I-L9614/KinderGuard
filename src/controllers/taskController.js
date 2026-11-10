import Task from '../models/Task.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';

// Tasks are personal by design: a branch user only ever sees the tasks he
// created. The general admin defaults to her own tasks and can widen to a
// read-only team view with ?scope=all. Only the creator may update or delete
// a task, including when the admin looks at someone else's task.
const ownScope = (user) => ({ adminId: getAdminId(user), createdBy: user._id });

const validateBranch = async (user, branchId) => {
  if (!branchId) return null;
  const branch = await Branch.findOne({ _id: branchId, adminId: getAdminId(user) });
  if (!branch) return 'הסניף לא נמצא';
  if (user.role === 'Manager' && !user.accessibleBranches.some((id) => String(id) === String(branch._id))) {
    return 'אין לכם גישה לסניף הזה';
  }
  return null;
};

export const listTasks = async (req, res) => {
  const filter = req.user.role === 'Admin' && req.query.scope === 'all'
    ? { adminId: getAdminId(req.user) }
    : ownScope(req.user);
  if (req.query.status) filter.status = req.query.status;
  const tasks = await Task.find(filter)
    .sort({ createdAt: -1 })
    .populate('createdBy', 'name')
    .populate('branchId', 'name');
  res.json(tasks.map((task) => ({ ...task.toObject(), editable: String(task.createdBy?._id || task.createdBy) === String(req.user._id) })));
};

export const createTask = async (req, res) => {
  const { title, notes = '', dueDate = null, branchId = null } = req.body;
  const branchError = await validateBranch(req.user, branchId);
  if (branchError) return res.status(400).json({ message: branchError });
  const task = await Task.create({
    adminId: getAdminId(req.user),
    createdBy: req.user._id,
    title,
    notes,
    dueDate: dueDate || null,
    branchId: branchId || null,
  });
  res.status(201).json(task);
};

const findEditableTask = async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, adminId: getAdminId(req.user) });
  if (!task) {
    res.status(404).json({ message: 'המשימה לא נמצאה' });
    return null;
  }
  if (String(task.createdBy) !== String(req.user._id)) {
    res.status(403).json({ message: 'רק מי שפתח את המשימה יכול לעדכן אותה.' });
    return null;
  }
  return task;
};

export const updateTask = async (req, res) => {
  const task = await findEditableTask(req, res);
  if (!task) return;
  const { title, notes, status, dueDate, branchId } = req.body;
  if (branchId !== undefined) {
    const branchError = await validateBranch(req.user, branchId);
    if (branchError) return res.status(400).json({ message: branchError });
    task.branchId = branchId || null;
  }
  if (title !== undefined) task.title = title;
  if (notes !== undefined) task.notes = notes;
  if (dueDate !== undefined) task.dueDate = dueDate || null;
  if (status !== undefined) {
    task.status = status;
    task.completedAt = status === 'Done' ? new Date() : null;
  }
  await task.save();
  res.json(task);
};

export const deleteTask = async (req, res) => {
  const task = await findEditableTask(req, res);
  if (!task) return;
  await task.deleteOne();
  res.json({ deleted: true });
};
