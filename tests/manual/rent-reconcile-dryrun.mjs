// Read-only dry-run of the NEW scheduling logic against a copy of the
// production rent data (fetched 2026-11-25 20:23 from the live summary API,
// names/amounts preserved, IDs synthesized). Prints exactly what the hourly
// maintenance would create after deploy and verifies nothing existing moves.
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import fs from 'fs';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'dryrun';

const agreements = JSON.parse(fs.readFileSync('/tmp/kg-agreements.json')).structured.agreements;
const payments = JSON.parse(fs.readFileSync('/tmp/kg-allpays.json')).structured;

const mongoServer = await MongoMemoryServer.create();
process.env.MONGO_URI = mongoServer.getUri('kinderguard-dryrun');
await mongoose.connect(process.env.MONGO_URI);

const { default: Branch } = await import('../../src/models/Branch.js');
const { default: Authority } = await import('../../src/models/Authority.js');
const { default: RentAgreement } = await import('../../src/models/RentAgreement.js');
const { default: RentPayment } = await import('../../src/models/RentPayment.js');
const { scheduleAllRentPayments, generateDueRentReminders } = await import('../../src/controllers/rentController.js');
const { default: RentReminder } = await import('../../src/models/RentReminder.js');

const adminId = new mongoose.Types.ObjectId();
const branchIds = new Map();
const authorityIds = new Map();
const branchIdFor = (name, kind) => {
  const key = `${name}|${kind}`;
  if (!branchIds.has(key)) branchIds.set(key, new mongoose.Types.ObjectId());
  return branchIds.get(key);
};
const authorityIdFor = (name) => {
  if (!authorityIds.has(name)) authorityIds.set(name, new mongoose.Types.ObjectId());
  return authorityIds.get(name);
};

const agIdMap = new Map();
for (const a of agreements) {
  const _id = new mongoose.Types.ObjectId();
  agIdMap.set(a.id, _id);
  await RentAgreement.create({
    _id,
    adminId,
    branchId: branchIdFor(a.branch, a.kind),
    authorityId: authorityIdFor(a.authority),
    direction: a.direction || 'outgoing',
    monthlyAmount: a.monthly,
    annualAmount: a.annual,
    frequency: a.frequency,
    firstDueDate: a.firstDue ? new Date(a.firstDue + 'T00:00:00Z') : null,
    paymentMethod: a.method,
    status: a.status,
  });
}
for (const p of payments) {
  await RentPayment.create({
    adminId,
    agreementId: agIdMap.get(p.ag),
    branchId: new mongoose.Types.ObjectId(),
    authorityId: new mongoose.Types.ObjectId(),
    branchName: 'x',
    authorityName: 'y',
    dueDate: new Date(p.due + 'T00:00:00Z'),
    amount: p.amount,
    method: 'cheque',
    status: p.status,
    lastEditedAt: p.edited ? new Date() : null,
    groupId: p.grouped ? new mongoose.Types.ObjectId() : null,
  });
}

const before = await RentPayment.find({}).lean();
const beforeKey = (p) => `${p.agreementId}|${p.dueDate.toISOString().slice(0, 10)}`;
const beforeMap = new Map(before.map((p) => [beforeKey(p), p]));

const created = await scheduleAllRentPayments();
await generateDueRentReminders();

const after = await RentPayment.find({}).lean();
const afterKeys = new Set(after.map(beforeKey));
const dupes = afterKeys.size !== after.length;
let changed = 0;
for (const p of after) {
  const b = beforeMap.get(beforeKey(p));
  if (!b) continue;
  if (b.amount !== p.amount || b.status !== p.status || String(b.lastEditedAt) !== String(p.lastEditedAt)) changed += 1;
}
const newRows = after.filter((p) => !beforeMap.has(beforeKey(p)));
const reminders = await RentReminder.find({}).lean();

// Per-agreement new-row breakdown
const agById = new Map([...agIdMap].map(([k, v]) => [String(v), k]));
const prodById = new Map(agreements.map((a) => [a.id, a]));
const perAg = {};
for (const p of newRows) {
  const prod = prodById.get(agById.get(String(p.agreementId)));
  const label = `${prod.branch} (${prod.frequency})`;
  perAg[label] = perAg[label] || { count: 0, dates: [], amount: p.amount };
  perAg[label].count += 1;
  perAg[label].dates.push(p.dueDate.toISOString().slice(0, 10));
}

console.log(JSON.stringify({
  before: before.length,
  after: after.length,
  created,
  newRows: newRows.length,
  duplicatesCreated: dupes,
  existingRowsChanged: changed,
  openRemindersAfterRun: reminders.filter((r) => r.status === 'Open').length,
  reminderSubjects: reminders.map((r) => r.dueDate ? r.dueDate.toISOString().slice(0, 10) : 'series'),
  perAgreement: perAg,
}, null, 2));

await mongoose.disconnect();
await mongoServer.stop();
