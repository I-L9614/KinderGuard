import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import RentAgreement from '../src/models/RentAgreement.js';
import RentPayment from '../src/models/RentPayment.js';
import RentReminder from '../src/models/RentReminder.js';
import Branch from '../src/models/Branch.js';
import { generateDueRentReminders, scheduleRentPayments } from '../src/controllers/rentController.js';
import { reconcileBranchDeletions } from '../src/services/licenseCleanup.js';

let app;
let mongoServer;
let token;
let adminId;
let branchId;
let authorityId;

const daysFromNow = (days) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return d; };
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `rent-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  token = admin.body.token;
  adminId = admin.body.id;
  const branch = await request(app).post('/api/branches').set(auth()).send({ name: 'גן שמש' }).expect(201);
  branchId = branch.body._id;
  const authority = await request(app).post('/api/rent/authorities').set(auth()).send({ name: 'מועצה אזורית שפיר' }).expect(201);
  authorityId = authority.body._id;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Rent module', () => {
  it('creates an agreement, defaults annual to monthly x12 and materializes the monthly schedule', async () => {
    const res = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 4800, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(5),
    }).expect(201);
    expect(res.body.annualAmount).toBe(57600);
    const payments = await RentPayment.find({ agreementId: res.body._id }).sort({ dueDate: 1 });
    expect(payments.length).toBeGreaterThanOrEqual(4);
    expect(payments[0].amount).toBe(4800);
    expect(payments[0].status).toBe('Pending');
    expect(payments[0].branchName).toBe('גן שמש');
    expect(payments[0].authorityName).toBe('מועצה אזורית שפיר');
    const gap = (payments[1].dueDate - payments[0].dueDate) / 86400000;
    expect(gap).toBeGreaterThanOrEqual(28);
    expect(gap).toBeLessThanOrEqual(31);
  });

  it('respects an explicit annual override and quarterly 3x period amounts', async () => {
    const res = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 3500, annualAmount: 21000, frequency: 'quarterly', paymentMethod: 'cheque', firstDueDate: daysFromNow(40),
    }).expect(201);
    expect(res.body.annualAmount).toBe(21000);
    const payments = await RentPayment.find({ agreementId: res.body._id }).sort({ dueDate: 1 });
    expect(payments[0].amount).toBe(10500);
  });

  it('uses explicit dates for custom frequency and rejects it without dates', async () => {
    await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 1000, frequency: 'custom', paymentMethod: 'transfer', firstDueDate: daysFromNow(10),
    }).expect(400);
    const res = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 1000, frequency: 'custom', paymentMethod: 'transfer',
      firstDueDate: daysFromNow(10), customDueDates: [daysFromNow(10), daysFromNow(70)],
    }).expect(201);
    const payments = await RentPayment.find({ agreementId: res.body._id }).sort({ dueDate: 1 });
    expect(payments).toHaveLength(2);
    expect(payments[0].amount).toBe(1000);
  });

  it('rejects invalid input and blocks agreements for a branch being deleted', async () => {
    await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: -5, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(5),
    }).expect(400);
    await Branch.updateOne({ _id: branchId }, { $set: { deleting: true } });
    await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 100, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(5),
    }).expect(409);
    await Branch.updateOne({ _id: branchId }, { $set: { deleting: false } });
  });

  it('generates a week-before reminder only within 7 days, and resolves it when the payment clears', async () => {
    const agreement = await RentAgreement.findOne({ branchId, frequency: 'monthly' });
    await generateDueRentReminders();
    // First due date is 5 days out -> reminder exists; a payment 40 days out has none.
    const payment = await RentPayment.findOne({ agreementId: agreement._id }).sort({ dueDate: 1 });
    const reminder = await RentReminder.findOne({ rentPaymentId: payment._id, rentTrigger: 'week_before_due' });
    expect(reminder).not.toBeNull();
    expect(reminder.status).toBe('Open');
    expect(reminder.amount).toBe(4800);
    const later = await RentPayment.findOne({ agreementId: agreement._id }).sort({ dueDate: -1 });
    expect(await RentReminder.findOne({ rentPaymentId: later._id })).toBeNull();
    // The merged inbox exposes it as kind: 'Rent'.
    const inbox = await request(app).get('/api/notifications').set(auth()).expect(200);
    const inInbox = inbox.body.find((n) => n.kind === 'Rent' && String(n.rentPaymentId) === String(payment._id));
    expect(inInbox).toBeTruthy();
    await request(app).post(`/api/rent/payments/${payment._id}/cleared`).set(auth()).expect(200);
    const after = await RentReminder.findById(reminder._id);
    expect(after.status).toBe('Resolved');
    const cleared = await RentPayment.findById(payment._id);
    expect(cleared.clearedAt).not.toBeNull();
  });

  it('enforces the cheque lifecycle: handed only for cheques, cleared only from pending/handed', async () => {
    const res = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 4000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: daysFromNow(3),
    }).expect(201);
    const transferPayment = await RentPayment.findOne({ agreementId: res.body._id });
    await request(app).post(`/api/rent/payments/${transferPayment._id}/handed`).set(auth()).expect(400);
    await request(app).post(`/api/rent/payments/${transferPayment._id}/cleared`).set(auth()).expect(200);
    await request(app).post(`/api/rent/payments/${transferPayment._id}/cleared`).set(auth()).expect(409);
    const chequePayment = await RentPayment.findOne({ method: 'cheque', status: 'Pending' });
    await request(app).post(`/api/rent/payments/${chequePayment._id}/handed`).set(auth()).expect(200);
    const handed = await RentPayment.findById(chequePayment._id);
    expect(handed.status).toBe('Handed');
    expect(handed.paidAt).not.toBeNull();
  });

  it('reminds one month before a deposited cheque series ends, and re-arms for a renewed series', async () => {
    const res = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 6200, frequency: 'monthly', paymentMethod: 'cheque',
      firstDueDate: daysFromNow(15),
      chequeSeries: { depositedCount: 12, seriesEndDate: daysFromNow(20) },
    }).expect(201);
    await generateDueRentReminders();
    const reminder = await RentReminder.findOne({ rentAgreementId: res.body._id, rentTrigger: 'month_before_series_end' });
    expect(reminder).not.toBeNull();
    expect(reminder.status).toBe('Open');
    // Renewing the series to a later end date leaves the old one out of scope
    // and does not create a new reminder until the new date is within a month.
    await request(app).patch(`/api/rent/agreements/${res.body._id}`).set(auth()).send({
      chequeSeries: { depositedCount: 12, seriesEndDate: daysFromNow(200) },
    }).expect(200);
    await generateDueRentReminders();
    expect(await RentReminder.countDocuments({ rentAgreementId: res.body._id, rentTrigger: 'month_before_series_end', status: 'Open' })).toBe(1); // the old one, until resolved
    await request(app).patch(`/api/notifications/${reminder._id}`).set(auth()).send({ status: 'Resolved' }).expect(200);
    expect(await RentReminder.countDocuments({ rentAgreementId: res.body._id, rentTrigger: 'month_before_series_end', status: 'Open' })).toBe(0);
    await request(app).patch(`/api/rent/agreements/${res.body._id}`).set(auth()).send({
      chequeSeries: { depositedCount: 12, seriesEndDate: daysFromNow(25) },
    }).expect(200);
    await generateDueRentReminders();
    expect(await RentReminder.countDocuments({ rentAgreementId: res.body._id, rentTrigger: 'month_before_series_end', status: 'Open' })).toBe(1);
  });

  it('blocks branch deletion while a rent agreement is active, and keeps payment history after close + delete', async () => {
    const branch = await request(app).post('/api/branches').set(auth()).send({ name: 'גן למחיקה' }).expect(201);
    const agreement = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branch.body._id, authorityId, monthlyAmount: 2000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(2),
    }).expect(201);
    const payment = await RentPayment.findOne({ agreementId: agreement.body._id });
    await request(app).post(`/api/rent/payments/${payment._id}/cleared`).set(auth()).expect(200);
    const blocked = await request(app).delete(`/api/branches/${branch.body._id}`).set(auth()).expect(409);
    expect(blocked.body.message).toContain('הסכמי שכירות פעילים');
    expect(await Branch.findById(branch.body._id)).not.toBeNull();
    await request(app).post(`/api/rent/agreements/${agreement.body._id}/close`).set(auth()).expect(200);
    // Closing cancels future pending payments; the cleared one stays.
    expect(await RentPayment.countDocuments({ agreementId: agreement.body._id, status: 'Cancelled' })).toBeGreaterThan(0);
    expect(await RentPayment.countDocuments({ agreementId: agreement.body._id, status: 'Cleared' })).toBe(1);
    await request(app).delete(`/api/branches/${branch.body._id}`).set(auth()).expect(200);
    await reconcileBranchDeletions();
    // Payment history survives branch deletion with its denormalized names.
    const history = await RentPayment.find({ agreementId: agreement.body._id, status: 'Cleared' });
    expect(history).toHaveLength(1);
    expect(history[0].branchName).toBe('גן למחיקה');
    expect(await RentReminder.countDocuments({ status: { $in: ['Open', 'In_Progress'] }, rentAgreementId: agreement.body._id })).toBe(0);
  });

  it('closes a raced active agreement during deletion recovery instead of orphaning it', async () => {
    const branch = await request(app).post('/api/branches').set(auth()).send({ name: 'גן מירוץ' }).expect(201);
    const agreement = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branch.body._id, authorityId, monthlyAmount: 1500, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(2),
    }).expect(201);
    // Simulate a crash window: branch deleted directly in DB while the
    // agreement insert raced past the guard, with deletion evidence recorded.
    const BranchDeletion = (await import('../src/models/BranchDeletion.js')).default;
    await BranchDeletion.create({ branchId: branch.body._id, adminId });
    await Branch.deleteOne({ _id: branch.body._id });
    await reconcileBranchDeletions();
    const after = await RentAgreement.findById(agreement.body._id);
    expect(after.status).toBe('Closed');
    expect(await RentPayment.countDocuments({ agreementId: agreement.body._id, status: 'Pending' })).toBe(0);
  });

  it('keeps rent data admin-only and totals per authority without double counting', async () => {
    await request(app).post('/api/users').set(auth()).send({ name: 'Manager', email: `mgr-${Date.now()}@example.com`, password: 'Password123', accessibleBranches: [] }).expect(201);
    const login = await request(app).post('/api/users/login').send({ email: `mgr-${Date.now()}@example.com`, password: 'Password123' });
    // look up the manager email we just created instead of guessing the timestamp
    const users = await request(app).get('/api/users').set(auth()).expect(200);
    const manager = users.body.find((u) => u.name === 'Manager');
    const mgrLogin = await request(app).post('/api/users/login').send({ email: manager.email, password: 'Password123' }).expect(200);
    await request(app).get('/api/rent/summary').set({ Authorization: `Bearer ${mgrLogin.body.token}` }).expect(403);
    const summary = await request(app).get('/api/rent/summary').set(auth()).expect(200);
    const active = summary.body.agreements.filter((a) => a.status === 'Active' && String(a.authorityId?._id || a.authorityId) === authorityId);
    const expectedMonthly = active.reduce((sum, a) => sum + a.monthlyAmount, 0);
    const expectedAnnual = active.reduce((sum, a) => sum + a.annualAmount, 0);
    expect(summary.body.totals[authorityId].monthly).toBe(expectedMonthly);
    expect(summary.body.totals[authorityId].annual).toBe(expectedAnnual);
  });

  it('blocks authority deletion while agreements are active and allows it after close', async () => {
    const authority = await request(app).post('/api/rent/authorities').set(auth()).send({ name: 'חוף אשקלון' }).expect(201);
    const branch = await request(app).post('/api/branches').set(auth()).send({ name: 'גן ים' }).expect(201);
    const agreement = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branch.body._id, authorityId: authority.body._id, monthlyAmount: 6200, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(10),
    }).expect(201);
    await request(app).delete(`/api/rent/authorities/${authority.body._id}`).set(auth()).expect(409);
    await request(app).post(`/api/rent/agreements/${agreement.body._id}/close`).set(auth()).expect(200);
    await request(app).delete(`/api/rent/authorities/${authority.body._id}`).set(auth()).expect(200);
  });

  it('materialization is idempotent across maintenance runs', async () => {
    const before = await RentPayment.countDocuments({});
    await scheduleRentPayments(await RentAgreement.findOne({ status: 'Active' }));
    await generateDueRentReminders();
    const after = await RentPayment.countDocuments({});
    expect(after).toBe(before);
  });
});

describe('Rent grouped payments, annual frequency and actual-paid reporting', () => {
  let branchBId;
  let mgrToken;

  it('schedules annual frequency as one payment per year at the stored annual amount', async () => {
    const res = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 5000, frequency: 'annual', paymentMethod: 'transfer', firstDueDate: daysFromNow(20),
    }).expect(201);
    const payments = await RentPayment.find({ agreementId: res.body._id }).sort({ dueDate: 1 });
    expect(payments).toHaveLength(1); // one per year within the 4-month horizon
    expect(payments[0].amount).toBe(60000);
  });

  it('groups one physical payment across two branches with total = sum of allocations', async () => {
    const branchB = await request(app).post('/api/branches').set(auth()).send({ name: 'גן ים' }).expect(201);
    branchBId = branchB.body._id;
    const agA = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 8300, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(15),
    }).expect(201);
    const agB = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branchBId, authorityId, monthlyAmount: 6100, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(15),
    }).expect(201);
    const payA = await RentPayment.findOne({ agreementId: agA.body._id });
    const payB = await RentPayment.findOne({ agreementId: agB.body._id });
    const res = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(15), paymentIds: [payA._id, payB._id],
    }).expect(201);
    expect(res.body.totalAmount).toBe(14400);
    expect(res.body.allocations).toHaveLength(2);
    expect(new Set(res.body.allocations.map((a) => String(a.branchId))).size).toBe(2);
    const updated = await RentPayment.findById(payA._id);
    expect(String(updated.groupId)).toBe(res.body._id);
    // A grouped payment's lifecycle is driven only by the group
    await request(app).post(`/api/rent/payments/${payA._id}/handed`).set(auth()).expect(409);
  });

  it('rejects mixed authorities, mixed methods and double grouping', async () => {
    const otherAuthority = await request(app).post('/api/rent/authorities').set(auth()).send({ name: 'מועצה אחרת' }).expect(201);
    const agOther = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId: otherAuthority.body._id, monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(15),
    }).expect(201);
    const grouped = await RentPayment.findOne({ groupId: { $ne: null } });
    const foreign = await RentPayment.findOne({ agreementId: agOther.body._id });
    await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(15), paymentIds: [foreign._id],
    }).expect(400); // payment belongs to another authority
    await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(15), paymentIds: [grouped._id],
    }).expect(409); // already grouped
    const transferPay = await RentPayment.findOne({ method: 'transfer', status: 'Pending', groupId: null });
    await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(15), paymentIds: [grouped._id, transferPay._id],
    }).expect(409); // already-grouped check fires before mixed-method would
  });

  it('cheque group: handed then cleared propagates to allocations and resolves reminders', async () => {
    const group = await request(app).get('/api/rent/payment-groups').set(auth()).expect(200);
    const g = group.body.find((x) => x.totalAmount === 14400);
    await generateDueRentReminders();
    const openBefore = await RentReminder.countDocuments({ status: 'Open' });
    expect(openBefore).toBeGreaterThan(0);
    await request(app).post(`/api/rent/payment-groups/${g._id}/handed`).set(auth()).expect(200);
    let payments = await RentPayment.find({ groupId: g._id });
    expect(payments.every((p) => p.status === 'Handed' && p.paidAt)).toBe(true);
    await request(app).post(`/api/rent/payment-groups/${g._id}/cleared`).set(auth()).expect(200);
    payments = await RentPayment.find({ groupId: g._id });
    expect(payments.every((p) => p.status === 'Cleared' && p.clearedAt)).toBe(true);
    for (const p of payments) {
      const reminder = await RentReminder.findOne({ rentPaymentId: p._id });
      if (reminder) expect(reminder.status).toBe('Resolved');
    }
  });

  it('rejects handed on a transfer group but allows direct clearing', async () => {
    const agT = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 2000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: daysFromNow(15),
    }).expect(201);
    const payT = await RentPayment.findOne({ agreementId: agT.body._id });
    const res = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'transfer', dueDate: daysFromNow(15), paymentIds: [payT._id],
    }).expect(201);
    await request(app).post(`/api/rent/payment-groups/${res.body._id}/handed`).set(auth()).expect(400);
    await request(app).post(`/api/rent/payment-groups/${res.body._id}/cleared`).set(auth()).expect(200);
    const payment = await RentPayment.findById(payT._id);
    expect(payment.status).toBe('Cleared');
  });

  it('close keeps a handed cheque obligation and its reminder; emptied group cancels', async () => {
    // New agreement for branchB, group its first two payments, hand the group
    const ag = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branchBId, authorityId, monthlyAmount: 4000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(3),
    }).expect(201);
    const payments = await RentPayment.find({ agreementId: ag.body._id }).sort({ dueDate: 1 });
    const [handedOne, pendingOne] = payments;
    const g1 = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(3), paymentIds: [handedOne._id],
    }).expect(201);
    await request(app).post(`/api/rent/payment-groups/${g1.body._id}/handed`).set(auth()).expect(200);
    const g2 = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(33), paymentIds: [pendingOne._id],
    }).expect(201);
    await generateDueRentReminders();
    const handedReminder = await RentReminder.findOne({ rentPaymentId: handedOne._id, status: 'Open' });
    expect(handedReminder).not.toBeNull();
    await request(app).post(`/api/rent/agreements/${ag.body._id}/close`).set(auth()).expect(200);
    const handedAfter = await RentPayment.findById(handedOne._id);
    expect(handedAfter.status).toBe('Handed'); // obligation preserved
    const reminderAfter = await RentReminder.findOne({ rentPaymentId: handedOne._id });
    expect(reminderAfter.status).toBe('Open'); // alert NOT resolved
    const pendingAfter = await RentPayment.findById(pendingOne._id);
    expect(pendingAfter.status).toBe('Cancelled');
    const g2After = await request(app).get('/api/rent/payment-groups').set(auth());
    expect(g2After.body.find((x) => x._id === g2.body._id).status).toBe('Cancelled'); // emptied group cancelled
    expect(g2After.body.find((x) => x._id === g2.body._id).totalAmount).toBe(0);
    const g1After = await request(app).get('/api/rent/payment-groups').set(auth());
    expect(g1After.body.find((x) => x._id === g1.body._id).status).toBe('Handed'); // handed group survives
    // The handed cheque still counts as outstanding in the report
    const report = await request(app).get(`/api/rent/reports/paid?authorityId=${authorityId}`).set(auth()).expect(200);
    const branchRow = report.body.authorities[0].branches.find((b) => String(b.branchId) === String(branchBId));
    const outstanding = await RentPayment.find({ branchId: branchBId, status: { $in: ['Pending', 'Handed'] } });
    const expected = outstanding
      .filter((x) => x.dueDate.getFullYear() === new Date().getFullYear())
      .reduce((sum, x) => sum + x.amount, 0);
    expect(branchRow.outstandingTotal).toBe(expected);
    expect(branchRow.outstandingTotal).toBeGreaterThanOrEqual(4000); // includes the preserved handed cheque
  });

  it('reports actual paid per authority and per branch with no double count, filtered by period', async () => {
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const yearEnd = `${new Date().getFullYear()}-12-31`;
    const report = await request(app).get(`/api/rent/reports/paid?from=${yearStart}&to=${yearEnd}`).set(auth()).expect(200);
    const shafir = report.body.authorities.find((a) => a.authorityName === 'מועצה אזורית שפיר');
    expect(shafir).toBeDefined();
    // Branch sums add up exactly to the authority total
    const branchSum = shafir.branches.reduce((s, b) => s + b.clearedTotal, 0);
    expect(branchSum).toBe(shafir.clearedTotal);
    expect(shafir.clearedCheque + shafir.clearedTransfer).toBe(shafir.clearedTotal);
    // Every cleared shekel in the DB appears exactly once: the report's
    // per-branch numbers equal direct DB sums per branch (the grouped cheque's
    // 8,300/6,100 allocations land under their own branches, not twice).
    const cleared = await RentPayment.find({ status: 'Cleared' });
    const dbSum = (name) => cleared.filter((p) => p.branchName === name).reduce((sum, p) => sum + p.amount, 0);
    const shemesh = shafir.branches.find((b) => b.branchName === 'גן שמש');
    const yam = shafir.branches.find((b) => b.branchName === 'גן ים');
    expect(shemesh.clearedTotal).toBe(dbSum('גן שמש'));
    expect(yam.clearedTotal).toBe(dbSum('גן ים'));
    expect(shemesh.clearedTotal).toBeGreaterThanOrEqual(8300 + 2000); // includes both grouped payments
    expect(yam.clearedTotal).toBeGreaterThanOrEqual(6100);
    // Period filter excludes payments outside the window
    const narrow = await request(app).get('/api/rent/reports/paid?from=2030-01-01&to=2030-12-31').set(auth()).expect(200);
    expect(narrow.body.authorities).toHaveLength(0);
  });

  it('keeps grouped payments and reports admin-only', async () => {
    await request(app).post('/api/users').set(auth()).send({ name: 'Manager2', email: `mgr2-${Date.now()}@example.com`, password: 'Password123', accessibleBranches: [] }).expect(201);
    const users = await request(app).get('/api/users').set(auth()).expect(200);
    const manager = users.body.find((u) => u.name === 'Manager2');
    const mgrLogin = await request(app).post('/api/users/login').send({ email: manager.email, password: 'Password123' }).expect(200);
    mgrToken = mgrLogin.body.token;
    const mgrAuth = { Authorization: `Bearer ${mgrToken}` };
    await request(app).post('/api/rent/payment-groups').set(mgrAuth).send({}).expect(403);
    await request(app).get('/api/rent/reports/paid').set(mgrAuth).expect(403);
    await request(app).get('/api/rent/payment-groups').set(mgrAuth).expect(403);
  });
});

describe('Rent group persistence hardening and report date modes', () => {
  it('retried group create returns the same group instead of duplicating allocations', async () => {
    const ag = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 2700, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(9),
    }).expect(201);
    const pay = await RentPayment.findOne({ agreementId: ag.body._id, status: 'Pending' });
    const body = { authorityId, method: 'cheque', dueDate: daysFromNow(9), paymentIds: [pay._id] };
    const first = await request(app).post('/api/rent/payment-groups').set(auth()).send(body).expect(201);
    // Simulate lost response: client retries the identical request
    const retry = await request(app).post('/api/rent/payment-groups').set(auth()).send(body).expect(200);
    expect(retry.body._id).toBe(first.body._id);
    const groups = await request(app).get('/api/rent/payment-groups').set(auth());
    expect(groups.body.filter((g) => g.allocations.some((a) => String(a.paymentId) === String(pay._id)))).toHaveLength(1);
  });

  it('handed/cleared are idempotent and converge payments after a partial failure', async () => {
    const group = (await request(app).get('/api/rent/payment-groups').set(auth()).expect(200)).body
      .find((g) => g.totalAmount === 2700 && g.status === 'Pending');
    await request(app).post(`/api/rent/payment-groups/${group._id}/handed`).set(auth()).expect(200);
    await request(app).post(`/api/rent/payment-groups/${group._id}/handed`).set(auth()).expect(200); // duplicate no-op
    // Simulate partial failure: one payment left behind in Pending
    const payment = await RentPayment.findOne({ groupId: group._id });
    payment.status = 'Pending'; payment.paidAt = null; await payment.save();
    await request(app).post(`/api/rent/payment-groups/${group._id}/handed`).set(auth()).expect(200); // retry converges it
    expect((await RentPayment.findById(payment._id)).status).toBe('Handed');
    await request(app).post(`/api/rent/payment-groups/${group._id}/cleared`).set(auth()).expect(200);
    await request(app).post(`/api/rent/payment-groups/${group._id}/cleared`).set(auth()).expect(200); // duplicate no-op
    expect((await RentPayment.findById(payment._id)).status).toBe('Cleared');
  });

  it('reconcile repairs a lost groupId link and divergent payment status', async () => {
    const ag = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 1900, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(11),
    }).expect(201);
    const pay = await RentPayment.findOne({ agreementId: ag.body._id, status: 'Pending' });
    const g = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(11), paymentIds: [pay._id],
    }).expect(201);
    await request(app).post(`/api/rent/payment-groups/${g.body._id}/cleared`).set(auth()).expect(200);
    // Simulate crash between group save and payment propagation
    pay.status = 'Pending'; pay.groupId = null; pay.clearedAt = null; pay.paidAt = null; await pay.save();
    const { reconcileRentPaymentGroups } = await import('../src/controllers/rentController.js');
    await reconcileRentPaymentGroups();
    const repaired = await RentPayment.findById(pay._id);
    expect(String(repaired.groupId)).toBe(g.body._id);
    expect(repaired.status).toBe('Cleared');
    expect(repaired.clearedAt).not.toBeNull();
  });

  it('cleared-date mode reports money that arrived in the period only', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cleared = await request(app).get(`/api/rent/reports/paid?from=${today}&to=${today}&dateField=cleared`).set(auth()).expect(200);
    expect(cleared.body.dateField).toBe('cleared');
    const total = cleared.body.authorities.reduce((s, a) => s + a.clearedTotal, 0);
    const dbTotal = (await RentPayment.find({ status: 'Cleared' })).reduce((s, p) => s + p.amount, 0);
    expect(total).toBe(dbTotal); // everything was cleared today in this suite
    // A window in the past with no clearances reports nothing
    const empty = await request(app).get('/api/rent/reports/paid?from=2020-01-01&to=2020-12-31&dateField=cleared').set(auth()).expect(200);
    expect(empty.body.authorities).toHaveLength(0);
  });
});

describe('Rent record corrections with audit trail', () => {
  it('edits a pending payment, keeps the original in audit, and marks the row', async () => {
    const ag = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 3300, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: daysFromNow(14),
    }).expect(201);
    const pay = await RentPayment.findOne({ agreementId: ag.body._id, status: 'Pending' });
    const newDate = daysFromNow(16);
    const res = await request(app).patch(`/api/rent/payments/${pay._id}`).set(auth()).send({
      amount: 3600, dueDate: newDate, reason: 'תוקן מול הרשות',
    }).expect(200);
    expect(res.body.amount).toBe(3600);
    expect(res.body.lastEditedAt).not.toBeNull();
    const RentAudit = (await import('../src/models/RentAudit.js')).default;
    const audit = await RentAudit.findOne({ paymentId: pay._id, action: 'edit_payment' });
    expect(audit.before.amount).toBe(3300);
    expect(audit.after.amount).toBe(3600);
    expect(audit.reason).toBe('תוקן מול הרשות');
    // no-change edit is rejected
    await request(app).patch(`/api/rent/payments/${pay._id}`).set(auth()).send({ amount: 3600, dueDate: newDate }).expect(400);
    // due-date collision with another scheduled payment is rejected
    const other = await RentPayment.findOne({ agreementId: ag.body._id, _id: { $ne: pay._id } }).sort({ dueDate: 1 });
    await request(app).patch(`/api/rent/payments/${pay._id}`).set(auth()).send({ dueDate: other.dueDate }).expect(409);
    // a non-pending payment cannot be edited
    await request(app).post(`/api/rent/payments/${pay._id}/cleared`).set(auth()).expect(200);
    await request(app).patch(`/api/rent/payments/${pay._id}`).set(auth()).send({ amount: 9999 }).expect(409);
    const stillThere = await RentAudit.countDocuments({ paymentId: pay._id });
    expect(stillThere).toBe(1);
  });

  it('editing a grouped payment keeps allocation and total consistent', async () => {
    const ag = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId, monthlyAmount: 4100, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(18),
    }).expect(201);
    const pay = await RentPayment.findOne({ agreementId: ag.body._id, status: 'Pending' });
    const g = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(18), paymentIds: [pay._id],
    }).expect(201);
    await request(app).patch(`/api/rent/payments/${pay._id}`).set(auth()).send({ amount: 4500 }).expect(200);
    const groups = await request(app).get('/api/rent/payment-groups').set(auth());
    const updated = groups.body.find((x) => x._id === g.body._id);
    expect(updated.allocations[0].amount).toBe(4500);
    expect(updated.totalAmount).toBe(4500);
  });

  it('cancels a grouped payment record: obligations return to pending, originals audited', async () => {
    const ag = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branchId, authorityId, monthlyAmount: 2900, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(6),
    }).expect(201);
    const agB = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: (await request(app).post('/api/branches').set(auth()).send({ name: 'גן נועם' }).expect(201)).body._id,
      authorityId, monthlyAmount: 3100, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: daysFromNow(6),
    }).expect(201);
    const payA = await RentPayment.findOne({ agreementId: ag.body._id, status: 'Pending' });
    const payB = await RentPayment.findOne({ agreementId: agB.body._id, status: 'Pending' });
    const g = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(6), paymentIds: [payA._id, payB._id],
    }).expect(201);
    await request(app).post(`/api/rent/payment-groups/${g.body._id}/handed`).set(auth()).expect(200);
    const res = await request(app).post(`/api/rent/payment-groups/${g.body._id}/cancel`).set(auth()).send({ reason: 'הצ\'ק לא נמסר בפועל' }).expect(200);
    expect(res.body.status).toBe('Cancelled');
    for (const id of [payA._id, payB._id]) {
      const p = await RentPayment.findById(id);
      expect(p.status).toBe('Pending');
      expect(p.groupId).toBeNull();
      expect(p.paidAt).toBeNull();
    }
    const RentAudit = (await import('../src/models/RentAudit.js')).default;
    const audit = await RentAudit.findOne({ groupId: g.body._id, action: 'cancel_group' });
    expect(audit.before.status).toBe('Handed');
    expect(audit.before.totalAmount).toBe(6000);
    expect(audit.before.allocations).toHaveLength(2);
    // idempotent: a second cancel is a no-op
    await request(app).post(`/api/rent/payment-groups/${g.body._id}/cancel`).set(auth()).send({}).expect(200);
    expect(await RentAudit.countDocuments({ groupId: g.body._id, action: 'cancel_group' })).toBe(1);
    // the returned obligations are groupable again
    const regroup = await request(app).post('/api/rent/payment-groups').set(auth()).send({
      authorityId, method: 'cheque', dueDate: daysFromNow(6), paymentIds: [payA._id, payB._id],
    }).expect(201);
    expect(regroup.body.totalAmount).toBe(6000);
  });

  it('refuses to cancel a cleared group (money actually moved)', async () => {
    const groups = await request(app).get('/api/rent/payment-groups').set(auth());
    const clearedGroup = groups.body.find((g) => g.status === 'Cleared');
    expect(clearedGroup).toBeDefined();
    await request(app).post(`/api/rent/payment-groups/${clearedGroup._id}/cancel`).set(auth()).send({}).expect(409);
  });
});
