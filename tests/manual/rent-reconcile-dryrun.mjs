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

// ---- Full cadence verification: every row of every active agreement must sit
// exactly on its cadence from the anchor, with the cadence's amount, and every
// expected date in the 12-month window must have a row.
const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addMonthsClamped = (value, months) => {
  const d = new Date(value);
  const target = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)));
};
const periodAmountOf = (a) => (a.frequency === 'quarterly'
  ? (a.monthly != null ? a.monthly * 3 : a.annual / 4)
  : a.frequency === 'annual' ? a.annual : a.monthly);
const horizon = addMonthsClamped(dayStart(new Date()), 12);
const verification = [];
let violations = 0;
for (const a of agreements) {
  if (a.status !== 'Active' || a.frequency === 'custom' || !a.firstDue) continue;
  const step = a.frequency === 'monthly' ? 1 : a.frequency === 'quarterly' ? 3 : 12;
  const anchor = dayStart(new Date(a.firstDue + 'T00:00:00Z'));
  const expected = [];
  for (let i = 0; ; i += 1) {
    const d = addMonthsClamped(anchor, i * step);
    if (d > horizon) break;
    expected.push(d.toISOString().slice(0, 10));
  }
  const expectedSet = new Set(expected);
  const rows = after.filter((p) => String(p.agreementId) === String(agIdMap.get(a.id)));
  const rowDates = rows.map((p) => p.dueDate.toISOString().slice(0, 10));
  const offCadence = rowDates.filter((d) => !expectedSet.has(d));
  const missing = expected.filter((d) => !rowDates.includes(d));
  const amount = periodAmountOf(a);
  const wrongAmount = rows.filter((p) => Math.abs(p.amount - amount) > 0.005).map((p) => `${p.dueDate.toISOString().slice(0, 10)}:${p.amount}`);
  const gaps = rowDates.sort().slice(1).map((d, i) => (new Date(d) - new Date(rowDates[i])) / 86400000);
  const badGap = gaps.filter((g) => g < step * 28 || g > step * 31);
  const ok = !offCadence.length && !missing.length && !wrongAmount.length && !badGap.length;
  if (!ok) violations += 1;
  verification.push({
    agreement: `${a.branch} (${a.frequency})`, rows: rows.length, expected: expected.length,
    offCadence, missing, wrongAmount, badGap, ok,
  });
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
  cadenceViolations: violations,
  verification: verification.filter((v) => !v.ok),
  verifiedAgreements: verification.length,
}, null, 2));

await mongoose.disconnect();
await mongoServer.stop();
