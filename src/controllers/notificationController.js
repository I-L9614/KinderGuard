import Notification from '../models/Notification.js';
import RentReminder from '../models/RentReminder.js';
import License from '../models/License.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';

const calendarDaysLeft = (expiryDate) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate); expiry.setHours(0, 0, 0, 0);
  return Math.round((expiry - today) / 86400000);
};

export const generateDueNotifications = async () => {
  const licenses = await License.find({ lifecycle: 'Active' });
  for (const license of licenses) {
    const daysLeft = calendarDaysLeft(license.expiryDate);
    // Catch up on the latest relevant checkpoint after the app has been closed.
    // Older missed reminders are not emitted in a burst; the current actionable
    // stage still becomes persistent as soon as maintenance runs again.
    const triggerDays = daysLeft <= 0 ? 0 : daysLeft <= 7 ? 7 : daysLeft <= 30 ? 30 : null;
    if (triggerDays === null) continue;
    const branch = await Branch.findById(license.branchId).select('adminId');
    if (!branch) continue;
    await Notification.updateOne(
      { licenseId: license._id, triggerDays },
      { $setOnInsert: { adminId: branch.adminId, branchId: license.branchId, licenseId: license._id, triggerDays, status: 'Open' } },
      { upsert: true },
    );
  }
  await Notification.updateMany(
    { status: { $in: ['Open', 'In_Progress'] }, licenseId: { $in: await License.find({ lifecycle: 'Replaced' }).distinct('_id') } },
    { status: 'Resolved', resolvedAt: new Date() },
  );
};

export const listNotifications = async (req, res) => {
  const filter = { adminId: getAdminId(req.user) };
  if (req.query.status) filter.status = req.query.status;
  if (req.user.role === 'Manager') filter.branchId = { $in: req.user.accessibleBranches };
  const items = await Notification.find(filter).sort({ createdAt: -1 }).populate('branchId', 'name').populate({ path: 'licenseId', populate: { path: 'licenseTypeId', select: 'name' } });
  // Rent reminders share this inbox; they carry kind: 'Rent' so the frontend
  // renders and routes them differently from license alerts.
  const rentItems = await RentReminder.find(filter).populate('branchId', 'name');
  const merged = [
    ...items.map((item) => ({ ...item.toObject(), kind: 'License' })),
    ...rentItems.map((item) => ({ ...item.toObject(), kind: 'Rent' })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(merged);
};

export const updateNotification = async (req, res) => {
  const scope = { _id: req.params.id, adminId: getAdminId(req.user), ...(req.user.role === 'Manager' ? { branchId: { $in: req.user.accessibleBranches } } : {}) };
  const notification = (await Notification.findOne(scope)) || (await RentReminder.findOne(scope));
  if (!notification) return res.status(404).json({ message: 'ההתראה לא נמצאה' });
  if (!['In_Progress', 'Resolved', 'Dismissed', 'Open'].includes(req.body.status)) return res.status(400).json({ message: 'מצב טיפול לא תקין' });
  notification.status = req.body.status;
  notification.resolvedAt = ['Resolved', 'Dismissed'].includes(req.body.status) ? new Date() : null;
  notification.resolvedBy = notification.resolvedAt ? req.user._id : null;
  await notification.save();
  res.json(notification);
};
