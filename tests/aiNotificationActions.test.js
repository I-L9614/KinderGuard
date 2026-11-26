import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeNotificationActions } from '../src/ai/notificationActions.js';
const deleted = [];
vi.mock('../src/services/s3Service.js', () => ({ uploadFileToS3: vi.fn(async () => 'k'), downloadFileFromS3: vi.fn(), deleteFileFromS3: vi.fn(async (k) => { deleted.push(k); }) }));
let Notification; let RentReminder; let License; let LicenseType; let AiProposal; let app; let mongoServer; let User; let Branch; let Authority; let RentAgreement; let ask;
const mk = async (extra) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `r-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', ...extra });
  return { u, t: jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }) };
};
beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js')); ({ default: Branch } = await import('../src/models/Branch.js')); ({ default: Authority } = await import('../src/models/Authority.js')); ({ default: RentAgreement } = await import('../src/models/RentAgreement.js'));
  ({ default: Notification } = await import('../src/models/Notification.js')); ({ default: RentReminder } = await import('../src/models/RentReminder.js')); ({ default: License } = await import('../src/models/License.js')); ({ default: LicenseType } = await import('../src/models/LicenseType.js'));
  ({ default: AiProposal } = await import('../src/models/AiProposal.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const items = [{ id: 'n1', kind: 'License', status: 'Open', branchName: 'גן א', subject: 'כיבוי', version: 'v' }, { id: 'r1', kind: 'Rent', status: 'In_Progress', branchName: 'גן ב', subject: 'שכירות', version: 'v' }];
describe('sanitizeNotificationActions', () => {
  it('only listed ids and kinds, real status change, no duplicates', () => {
    const r = sanitizeNotificationActions(JSON.stringify({ actions: [{ type: 'set_notification_status', notificationId: 'n1', kind: 'License', status: 'Resolved' }, { type: 'set_notification_status', notificationId: 'n1', kind: 'License', status: 'Dismissed' }, { type: 'set_notification_status', notificationId: 'n1', kind: 'Rent', status: 'Resolved' }, { type: 'set_notification_status', notificationId: 'r1', kind: 'Rent', status: 'In_Progress' }, { type: 'set_notification_status', notificationId: 'r1', kind: 'Rent', status: 'Bogus' }, { type: 'delete_all' }] }), items);
    expect(r.actions).toHaveLength(1); expect(r.actions[0].to).toBe('Resolved'); expect(r.rejected).toHaveLength(5);
  });
});
describe('notification actions end to end', () => {
  const prop = (t, acts) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: acts }), costUsd: 0 }); return request(app).post('/api/ai/notifications/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); };
  const confirm = (t, id) => request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`).send({});
  const seed = async (u, bname) => { const b = await Branch.create({ adminId: u.adminId || u._id, name: bname }); const ty = await LicenseType.create({ adminId: u.adminId || u._id, name: `ס${Math.random()}` }); const l = await License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-01-01'), expiryDate: new Date('2027-01-01'), createdBy: u._id }); const n = await Notification.create({ adminId: u.adminId || u._id, branchId: b._id, licenseId: l._id, triggerDays: 30 }); return { b, n }; };
  it('changes status of exactly the proposed alert, refuses stale, other admin alerts are not proposable', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { n } = await seed(u, 'גן ראשון'); const { n: n2 } = await seed(u, 'גן שני');
    const p = await prop(t, [{ type: 'set_notification_status', notificationId: String(n._id), kind: 'License', status: 'Resolved' }]); expect(p.body.actions).toHaveLength(1);
    await Notification.updateOne({ _id: n._id }, { $set: { status: 'In_Progress' } });
    expect((await confirm(t, p.body.actions[0].proposalId)).status).toBe(409); expect((await Notification.findById(n._id)).status).toBe('In_Progress');
    const p2 = await prop(t, [{ type: 'set_notification_status', notificationId: String(n._id), kind: 'License', status: 'Resolved' }]); const ok = await confirm(t, p2.body.actions[0].proposalId); expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const a = await Notification.findById(n._id); expect(a.status).toBe('Resolved'); expect(String(a.resolvedBy)).toBe(String(u._id)); expect((await Notification.findById(n2._id)).status).toBe('Open');
    const o = await mk({ aiEnabled: true }); const q = await prop(o.t, [{ type: 'set_notification_status', notificationId: String(n2._id), kind: 'License', status: 'Dismissed' }]); expect(q.body.actions).toHaveLength(0);
  });
  it('rent reminder works; a manager only reaches alerts of assigned branches', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { b } = await seed(u, 'גן ג'); const { b: b2, n: n2 } = await seed(u, 'גן ד');
    const ag = new mongoose.Types.ObjectId(); const rr = await RentReminder.create({ adminId: u._id, branchId: b._id, rentAgreementId: ag, rentTrigger: 'week_before_due', dueDate: new Date('2027-01-05'), rentPaymentId: new mongoose.Types.ObjectId() });
    const p = await prop(t, [{ type: 'set_notification_status', notificationId: String(rr._id), kind: 'Rent', status: 'Dismissed' }]); expect((await confirm(t, p.body.actions[0].proposalId)).status).toBe(200); expect((await RentReminder.findById(rr._id)).status).toBe('Dismissed');
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id, accessibleBranches: [b._id] });
    const q = await prop(m.t, [{ type: 'set_notification_status', notificationId: String(n2._id), kind: 'License', status: 'Resolved' }]); expect(q.status).toBe(200); expect(q.body.actions).toHaveLength(0);
    expect(b2).toBeTruthy();
  });
});
