import Authority from '../models/Authority.js';
import RentAgreement from '../models/RentAgreement.js';
import RentPayment from '../models/RentPayment.js';
import RentReminder from '../models/RentReminder.js';
import RentPaymentGroup from '../models/RentPaymentGroup.js';
import RentAudit from '../models/RentAudit.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';

const dayStart = (value = new Date()) => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d; };
const dayEnd = (value = new Date()) => { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; };
const addMonths = (value, months) => { const d = new Date(value); d.setMonth(d.getMonth() + months); return d; };
const DAYS = 86400000;
// Payments are materialized this far ahead so reminders always have rows.
const SCHEDULE_HORIZON_MONTHS = 4;
const WEEK_BEFORE_DAYS = 7;
const MONTH_BEFORE_DAYS = 30;

const validDate = (value) => value && !Number.isNaN(new Date(value).getTime());

// Due amount per scheduled payment: quarterly pays 3 months, annual pays the
// stored yearly figure, monthly and custom pay the monthly amount.
const periodAmount = (agreement) => (agreement.frequency === 'quarterly' ? agreement.monthlyAmount * 3
  : agreement.frequency === 'annual' ? agreement.annualAmount
    : agreement.monthlyAmount);

// Materializes scheduled payments for one agreement, idempotently (the
// {agreementId, dueDate} unique key makes re-runs no-ops for existing rows).
export const scheduleRentPayments = async (agreement) => {
  if (agreement.status !== 'Active') return 0;
  // No amount or no schedule yet: the agreement is a record only, so nothing
  // is materialized (a missing amount is never scheduled as zero).
  if (agreement.monthlyAmount == null || !agreement.firstDueDate) return 0;
  const horizon = addMonths(dayStart(), SCHEDULE_HORIZON_MONTHS);
  const dates = [];
  if (agreement.frequency === 'custom') {
    for (const d of agreement.customDueDates || []) {
      const date = dayStart(d);
      if (date <= horizon) dates.push(date);
    }
  } else {
    const step = agreement.frequency === 'monthly' ? 1 : agreement.frequency === 'quarterly' ? 3 : 12;
    for (let d = dayStart(agreement.firstDueDate); d <= horizon; d = addMonths(d, step)) dates.push(new Date(d));
  }
  const branch = await Branch.findById(agreement.branchId).select('name');
  const authority = await Authority.findById(agreement.authorityId).select('name');
  let created = 0;
  for (const dueDate of dates) {
    const result = await RentPayment.updateOne(
      { agreementId: agreement._id, dueDate },
      {
        $setOnInsert: {
          adminId: agreement.adminId,
          branchId: agreement.branchId,
          authorityId: agreement.authorityId,
          branchName: branch?.name || '',
          authorityName: authority?.name || '',
          dueDate,
          amount: periodAmount(agreement),
          method: agreement.paymentMethod,
          status: 'Pending',
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount) created += 1;
  }
  return created;
};

export const scheduleAllRentPayments = async () => {
  const agreements = await RentAgreement.find({ status: 'Active' });
  for (const agreement of agreements) await scheduleRentPayments(agreement);
};

// The two distinct reminder rules: one week before each payment's due date,
// and one month before a deposited cheque series runs out. Both are idempotent
// upserts; reminders resolve when their payment clears or their agreement closes.
export const generateDueRentReminders = async () => {
  const today = dayStart();
  const inWeek = new Date(today.getTime() + WEEK_BEFORE_DAYS * DAYS);
  const inMonth = new Date(today.getTime() + MONTH_BEFORE_DAYS * DAYS);

  const dueSoon = await RentPayment.find({ status: { $in: ['Pending', 'Handed'] }, dueDate: { $gte: today, $lte: inWeek } });
  for (const payment of dueSoon) {
    await RentReminder.updateOne(
      { rentPaymentId: payment._id, rentTrigger: 'week_before_due' },
      {
        $setOnInsert: {
          adminId: payment.adminId,
          branchId: payment.branchId,
          branchName: payment.branchName,
          rentAgreementId: payment.agreementId,
          rentPaymentId: payment._id,
          rentTrigger: 'week_before_due',
          dueDate: payment.dueDate,
          amount: payment.amount,
          method: payment.method,
          status: 'Open',
        },
      },
      { upsert: true },
    );
  }

  const seriesEnding = await RentAgreement.find({
    status: 'Active',
    'chequeSeries.seriesEndDate': { $gte: today, $lte: inMonth },
  });
  for (const agreement of seriesEnding) {
    const branch = await Branch.findById(agreement.branchId).select('name');
    await RentReminder.updateOne(
      { rentAgreementId: agreement._id, rentTrigger: 'month_before_series_end', seriesEndDate: agreement.chequeSeries.seriesEndDate },
      {
        $setOnInsert: {
          adminId: agreement.adminId,
          branchId: agreement.branchId,
          branchName: branch?.name || '',
          rentAgreementId: agreement._id,
          rentTrigger: 'month_before_series_end',
          seriesEndDate: agreement.chequeSeries.seriesEndDate,
          method: agreement.paymentMethod,
          status: 'Open',
        },
      },
      { upsert: true },
    );
  }

  // Resolve reminders whose subject is gone: payment cleared/cancelled, or
  // agreement closed (series-end reminder is re-armed by editing the series).
  const clearedIds = await RentPayment.find({ status: { $in: ['Cleared', 'Cancelled'] } }).distinct('_id');
  await RentReminder.updateMany(
    { status: { $in: ['Open', 'In_Progress'] }, rentPaymentId: { $in: clearedIds } },
    { status: 'Resolved', resolvedAt: new Date() },
  );
  const closedIds = await RentAgreement.find({ status: 'Closed' }).distinct('_id');
  // Series-end reminders die with their agreement. Payment-linked reminders
  // resolve only through their payment (Cleared/Cancelled above): a cheque
  // already handed but not yet cleared stays an open obligation with its
  // reminder even after the agreement closes.
  await RentReminder.updateMany(
    { status: { $in: ['Open', 'In_Progress'] }, rentAgreementId: { $in: closedIds }, rentPaymentId: null },
    { status: 'Resolved', resolvedAt: new Date() },
  );
};

export const listAuthorities = async (req, res) => {
  const authorities = await Authority.find({ adminId: getAdminId(req.user) }).sort({ name: 1 });
  res.json(authorities);
};

export const createAuthority = async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'יש להזין שם רשות' });
  const type = req.body.type === 'private' ? 'private' : 'council';
  const authority = await Authority.create({ adminId: getAdminId(req.user), name, type });
  res.status(201).json(authority);
};

export const deleteAuthority = async (req, res) => {
  const adminId = getAdminId(req.user);
  const authority = await Authority.findOne({ _id: req.params.id, adminId });
  if (!authority) return res.status(404).json({ message: 'הרשות לא נמצאה' });
  const active = await RentAgreement.countDocuments({ authorityId: authority._id, status: 'Active' });
  if (active > 0) return res.status(409).json({ message: `לרשות יש ${active} הסכמי שכירות פעילים. סגרו אותם לפני מחיקת הרשות.` });
  // Closed agreements and payment history keep their denormalized names.
  await authority.deleteOne();
  res.json({ ok: true });
};

const validateAgreementInput = async (req, res) => {
  const adminId = getAdminId(req.user);
  const { branchId, authorityId, monthlyAmount, annualAmount, frequency, firstDueDate, paymentMethod } = req.body;
  // Amounts are optional: the user adds them later. A missing amount is
  // stored as null (never zero) and no payment schedule is materialized.
  const hasMonthly = monthlyAmount !== undefined && monthlyAmount !== null && monthlyAmount !== '';
  const monthly = hasMonthly ? Number(monthlyAmount) : null;
  if (hasMonthly && !(monthly > 0)) { res.status(400).json({ message: 'יש להזין סכום חודשי חיובי' }); return null; }
  const hasAnnual = annualAmount !== undefined && annualAmount !== null && annualAmount !== '';
  const annual = hasAnnual ? Number(annualAmount) : (monthly != null ? monthly * 12 : null);
  if (hasAnnual && !(annual >= 0)) { res.status(400).json({ message: 'הסכום השנתי אינו תקין' }); return null; }
  // Schedule fields are required once an amount exists; without an amount
  // they stay unset so nothing invented is displayed or scheduled.
  if (monthly != null || frequency) {
    if (!['monthly', 'quarterly', 'annual', 'custom'].includes(frequency)) { res.status(400).json({ message: 'תדירות התשלום אינה תקינה' }); return null; }
  }
  if (monthly != null || paymentMethod) {
    if (!['cheque', 'transfer'].includes(paymentMethod)) { res.status(400).json({ message: 'אמצעי התשלום אינו תקין' }); return null; }
  }
  if (monthly != null && !validDate(firstDueDate)) { res.status(400).json({ message: 'יש להזין תאריך פרעון ראשון תקין' }); return null; }
  if (firstDueDate && !validDate(firstDueDate)) { res.status(400).json({ message: 'יש להזין תאריך פרעון ראשון תקין' }); return null; }
  const direction = req.body.direction === 'incoming' ? 'incoming' : 'outgoing';
  const branch = await Branch.findOne({ _id: branchId, adminId });
  if (!branch) { res.status(404).json({ message: 'הסניף לא נמצא' }); return null; }
  if (branch.deleting) { res.status(409).json({ message: 'הסניף בתהליך מחיקה - לא ניתן להוסיף הסכם שכירות' }); return null; }
  const authority = await Authority.findOne({ _id: authorityId, adminId });
  if (!authority) { res.status(404).json({ message: 'הרשות לא נמצאה' }); return null; }
  let customDueDates = [];
  if (frequency === 'custom') {
    if (monthly == null) { res.status(400).json({ message: 'בתדירות מותאמת יש להזין סכום חודשי' }); return null; }
    customDueDates = (Array.isArray(req.body.customDueDates) ? req.body.customDueDates : []).filter(validDate).map((d) => dayStart(d));
    if (!customDueDates.length) { res.status(400).json({ message: 'בתדירות מותאמת יש להזין לפחות מועד פרעון אחד' }); return null; }
  }
  let chequeSeries;
  const series = req.body.chequeSeries;
  if (series && (series.depositedCount || series.seriesEndDate)) {
    if (paymentMethod !== 'cheque') { res.status(400).json({ message: 'סדרת צ\'קים מופקדת רלוונטית רק לתשלום בצ\'קים' }); return null; }
    if (!validDate(series.seriesEndDate)) { res.status(400).json({ message: 'יש להזין תאריך סיום תקין לסדרת הצ\'קים' }); return null; }
    chequeSeries = {
      depositedCount: Math.max(0, Number(series.depositedCount) || 0),
      seriesStartDate: validDate(series.seriesStartDate) ? dayStart(series.seriesStartDate) : undefined,
      seriesEndDate: dayStart(series.seriesEndDate),
    };
  }
  return { adminId, branch, authority, monthly, annual, frequency: frequency || null, customDueDates, paymentMethod: paymentMethod || null, firstDueDate: validDate(firstDueDate) ? dayStart(firstDueDate) : null, chequeSeries, direction };
};

export const createAgreement = async (req, res) => {
  const input = await validateAgreementInput(req, res);
  if (!input) return;
  const agreement = await RentAgreement.create({
    adminId: input.adminId,
    branchId: input.branch._id,
    authorityId: input.authority._id,
    direction: input.direction,
    monthlyAmount: input.monthly,
    annualAmount: input.annual,
    frequency: input.frequency,
    firstDueDate: input.firstDueDate,
    customDueDates: input.customDueDates,
    paymentMethod: input.paymentMethod,
    chequeSeries: input.chequeSeries,
  });
  await scheduleRentPayments(agreement);
  await generateDueRentReminders();
  res.status(201).json(agreement);
};

export const updateAgreement = async (req, res) => {
  const adminId = getAdminId(req.user);
  const agreement = await RentAgreement.findOne({ _id: req.params.id, adminId });
  if (!agreement) return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  const body = { ...req.body };
  // Keep the stored annual figure independent: it only re-derives from the
  // monthly amount when explicitly sent empty, never silently.
  if (body.direction !== undefined) {
    if (!['incoming', 'outgoing'].includes(body.direction)) return res.status(400).json({ message: 'כיוון התשלום אינו תקין' });
    agreement.direction = body.direction;
  }
  if (body.monthlyAmount !== undefined) {
    const monthly = Number(body.monthlyAmount);
    if (!(monthly > 0)) return res.status(400).json({ message: 'יש להזין סכום חודשי חיובי' });
    agreement.monthlyAmount = monthly;
    if (body.annualAmount === undefined && agreement.annualAmount == null) agreement.annualAmount = monthly * 12;
  }
  // Schedule fields become editable here so an amount-less record can be
  // completed later; once an amount exists all three must be present.
  if (body.frequency !== undefined) {
    if (!['monthly', 'quarterly', 'annual', 'custom'].includes(body.frequency)) return res.status(400).json({ message: 'תדירות התשלום אינה תקינה' });
    agreement.frequency = body.frequency;
  }
  if (body.paymentMethod !== undefined) {
    if (!['cheque', 'transfer'].includes(body.paymentMethod)) return res.status(400).json({ message: 'אמצעי התשלום אינו תקין' });
    agreement.paymentMethod = body.paymentMethod;
  }
  if (body.firstDueDate !== undefined) {
    if (!validDate(body.firstDueDate)) return res.status(400).json({ message: 'יש להזין תאריך פרעון ראשון תקין' });
    agreement.firstDueDate = dayStart(body.firstDueDate);
  }
  if (agreement.monthlyAmount != null && (!agreement.frequency || !agreement.paymentMethod || !agreement.firstDueDate)) {
    return res.status(400).json({ message: 'עם סכום חודשי יש להזין גם תדירות, אמצעי תשלום ותאריך פרעון ראשון' });
  }
  if (body.annualAmount !== undefined && body.annualAmount !== '') {
    const annual = Number(body.annualAmount);
    if (!(annual >= 0)) return res.status(400).json({ message: 'הסכום השנתי אינו תקין' });
    agreement.annualAmount = annual;
  }
  const series = body.chequeSeries;
  if (series) {
    if (agreement.paymentMethod !== 'cheque') return res.status(400).json({ message: 'סדרת צ\'קים מופקדת רלוונטית רק לתשלום בצ\'קים' });
    if (!validDate(series.seriesEndDate)) return res.status(400).json({ message: 'יש להזין תאריך סיום תקין לסדרת הצ\'קים' });
    agreement.chequeSeries = {
      depositedCount: Math.max(0, Number(series.depositedCount) || 0),
      seriesStartDate: validDate(series.seriesStartDate) ? dayStart(series.seriesStartDate) : undefined,
      seriesEndDate: dayStart(series.seriesEndDate),
    };
  }
  await agreement.save();
  await scheduleRentPayments(agreement);
  await generateDueRentReminders();
  res.json(agreement);
};

// Closing an agreement (by the user or by deletion recovery) cancels only
// payments nothing was handed over for. A cancelled payment is pulled out of
// its grouped payment (the group total shrinks; an emptied group cancels).
// Handed-but-uncleared cheques stay open obligations with their reminders.
export const cancelScheduledPayments = async (agreementId) => {
  const pending = await RentPayment.find({ agreementId, status: 'Pending' });
  for (const payment of pending) {
    payment.status = 'Cancelled';
    await payment.save();
    if (!payment.groupId) continue;
    const group = await RentPaymentGroup.findById(payment.groupId);
    if (!group || !['Pending', 'Handed'].includes(group.status)) continue;
    group.allocations = group.allocations.filter((a) => String(a.paymentId) !== String(payment._id));
    group.totalAmount = group.allocations.reduce((sum, a) => sum + a.amount, 0);
    if (!group.allocations.length) { group.status = 'Cancelled'; group.cancelledAt = new Date(); }
    await group.save();
  }
  return pending.map((p) => p._id);
};

export const closeAgreement = async (req, res) => {
  const adminId = getAdminId(req.user);
  const agreement = await RentAgreement.findOne({ _id: req.params.id, adminId });
  if (!agreement) return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  if (agreement.status === 'Closed') return res.json(agreement);
  agreement.status = 'Closed';
  agreement.closedAt = new Date();
  await agreement.save();
  const cancelledIds = await cancelScheduledPayments(agreement._id);
  // Resolve only reminders whose obligation ended: series-end reminders and
  // reminders of the just-cancelled payments. Handed cheques stay reminded.
  await RentReminder.updateMany(
    { status: { $in: ['Open', 'In_Progress'] }, rentAgreementId: agreement._id, $or: [{ rentPaymentId: null }, { rentPaymentId: { $in: cancelledIds } }] },
    { status: 'Resolved', resolvedAt: new Date(), resolvedBy: req.user._id },
  );
  res.json(agreement);
};

const findPayment = async (req, res) => {
  const payment = await RentPayment.findOne({ _id: req.params.id, adminId: getAdminId(req.user) });
  if (!payment) { res.status(404).json({ message: 'התשלום לא נמצא' }); return null; }
  return payment;
};

export const markPaymentHanded = async (req, res) => {
  const payment = await findPayment(req, res);
  if (!payment) return;
  if (payment.groupId) return res.status(409).json({ message: 'התשלום שובץ לתשלום מרוכז - מסירה ופרעון מסומנים על התשלום המרוכז עצמו' });
  if (payment.method !== 'cheque') return res.status(400).json({ message: 'סימון ״צ\'ק נמסר״ רלוונטי רק לתשלום בצ\'ק. בהעברה בנקאית סמנו ישירות ״נפרע״.' });
  if (payment.status !== 'Pending') return res.status(409).json({ message: 'אפשר לסמן ״נמסר״ רק תשלום שממתין למסירה' });
  payment.status = 'Handed';
  payment.paidAt = new Date();
  await payment.save();
  res.json(payment);
};

export const markPaymentCleared = async (req, res) => {
  const payment = await findPayment(req, res);
  if (!payment) return;
  if (payment.groupId) return res.status(409).json({ message: 'התשלום שובץ לתשלום מרוכז - מסירה ופרעון מסומנים על התשלום המרוכז עצמו' });
  if (!['Pending', 'Handed'].includes(payment.status)) return res.status(409).json({ message: 'התשלום כבר נפרע או בוטל' });
  payment.status = 'Cleared';
  payment.clearedAt = new Date();
  if (!payment.paidAt) payment.paidAt = payment.clearedAt;
  await payment.save();
  await generateDueRentReminders(); // resolves this payment's week-before reminder
  res.json(payment);
};

// One payload for the rent screen: authorities with their agreements, the
// scheduled payments in view, and per-authority totals. Totals are plain sums
// of per-branch agreements, so one council payment covering several daycares
// is never counted twice.
export const rentSummary = async (req, res) => {
  const adminId = getAdminId(req.user);
  const [authorities, agreements, payments, groups] = await Promise.all([
    Authority.find({ adminId }).sort({ name: 1 }),
    RentAgreement.find({ adminId }).sort({ createdAt: -1 }).populate('branchId', 'name kind').populate('authorityId', 'name'),
    RentPayment.find({ adminId, status: { $ne: 'Cancelled' } }).sort({ dueDate: 1 }),
    RentPaymentGroup.find({ adminId, status: { $ne: 'Cancelled' } }).sort({ dueDate: 1 }),
  ]);
  const active = agreements.filter((a) => a.status === 'Active');
  const totals = {};
  for (const agreement of active) {
    const key = String(agreement.authorityId?._id || agreement.authorityId);
    totals[key] = totals[key] || { monthly: 0, annual: 0 };
    totals[key].monthly += agreement.monthlyAmount || 0;
    totals[key].annual += agreement.annualAmount || 0;
  }
  res.json({ authorities, agreements, payments, groups, totals });
};

// ----- Grouped payments: one physical cheque/transfer allocated across daycares -----

export const listPaymentGroups = async (req, res) => {
  const filter = { adminId: getAdminId(req.user) };
  if (req.query.authorityId) filter.authorityId = req.query.authorityId;
  const groups = await RentPaymentGroup.find(filter).sort({ dueDate: -1 });
  res.json(groups);
};

// Groups selected pending payments of one authority and one method into a
// single physical payment. totalAmount is the sum of the allocations, never
// a separate editable figure, so the parts and the whole cannot disagree.
export const createPaymentGroup = async (req, res) => {
  const adminId = getAdminId(req.user);
  const { authorityId, method, dueDate, note } = req.body;
  const ids = [...new Set(Array.isArray(req.body.paymentIds) ? req.body.paymentIds : [])];
  if (!ids.length) return res.status(400).json({ message: 'יש לבחור לפחות תשלום אחד לתשלום המרוכז' });
  if (!['cheque', 'transfer'].includes(method)) return res.status(400).json({ message: 'אמצעי התשלום אינו תקין' });
  if (!validDate(dueDate)) return res.status(400).json({ message: 'יש להזין מועד תשלום תקין' });
  const authority = await Authority.findOne({ _id: authorityId, adminId });
  if (!authority) return res.status(404).json({ message: 'הרשות לא נמצאה' });
  const payments = await RentPayment.find({ _id: { $in: ids }, adminId });
  if (payments.length !== ids.length) return res.status(400).json({ message: 'חלק מהתשלומים שנבחרו לא נמצאו' });
  // A retried create must never duplicate allocations: if these exact payments
  // already sit in one live group (e.g. the first attempt saved the group but
  // the response was lost), return that group instead of creating a second.
  const existing = await RentPaymentGroup.find({ status: { $ne: 'Cancelled' }, 'allocations.paymentId': { $in: ids } });
  if (existing.length) {
    const same = existing.length === 1 && existing[0].allocations.length === ids.length
      && existing[0].allocations.every((a) => ids.some((id) => String(id) === String(a.paymentId)));
    if (same) return res.status(200).json(existing[0]);
    return res.status(409).json({ message: 'חלק מהתשלומים כבר שובצו לתשלום מרוכז אחר' });
  }
  if (payments.some((p) => p.status !== 'Pending')) return res.status(409).json({ message: 'אפשר לשבץ רק תשלומים שממתינים למסירה' });
  if (payments.some((p) => p.groupId)) return res.status(409).json({ message: 'חלק מהתשלומים כבר שובצו לתשלום מרוכז אחר' });
  if (payments.some((p) => String(p.authorityId) !== String(authority._id))) return res.status(400).json({ message: 'כל התשלומים בתשלום מרוכז חייבים להיות לאותה רשות' });
  if (payments.some((p) => p.method !== method)) return res.status(400).json({ message: 'אמצעי התשלום חייב להיות זהה לכל התשלומים בתשלום המרוכז' });
  const allocations = payments.map((p) => ({ paymentId: p._id, agreementId: p.agreementId, branchId: p.branchId, branchName: p.branchName, amount: p.amount }));
  const totalAmount = allocations.reduce((sum, a) => sum + a.amount, 0);
  const group = await RentPaymentGroup.create({
    adminId,
    authorityId: authority._id,
    authorityName: authority.name,
    method,
    totalAmount,
    dueDate: dayStart(dueDate),
    note: String(note || '').trim(),
    allocations,
  });
  await RentPayment.updateMany({ _id: { $in: ids } }, { groupId: group._id });
  res.status(201).json(group);
};

const findGroup = async (req, res) => {
  const group = await RentPaymentGroup.findOne({ _id: req.params.id, adminId: getAdminId(req.user) });
  if (!group) { res.status(404).json({ message: 'התשלום המרוכז לא נמצא' }); return null; }
  return group;
};

// Propagating a group state onto its payments can only converge, never
// diverge: payment filters target the states that still need the transition,
// so a retried call after a partial failure finishes the remaining payments,
// and a duplicate call is a harmless no-op.
const propagateGroupState = async (group) => {
  if (group.status === 'Handed') {
    await RentPayment.updateMany({ groupId: group._id, status: 'Pending' }, { status: 'Handed', paidAt: group.handedAt });
  } else if (group.status === 'Cleared') {
    await RentPayment.updateMany(
      { groupId: group._id, status: { $in: ['Pending', 'Handed'] } },
      [{ $set: { status: 'Cleared', clearedAt: group.clearedAt, paidAt: { $ifNull: ['$paidAt', group.clearedAt] } } }],
    );
  }
  // Re-link payments that missed the groupId write (partial create failure).
  await RentPayment.updateMany(
    { _id: { $in: group.allocations.map((a) => a.paymentId) }, groupId: null },
    { groupId: group._id },
  );
};

export const markGroupHanded = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  if (group.method !== 'cheque') return res.status(400).json({ message: 'סימון ״צ\'ק נמסר״ רלוונטי רק לתשלום בצ\'ק. בהעברה בנקאית סמנו ישירות ״נפרע״.' });
  if (group.status === 'Handed') { await propagateGroupState(group); return res.json(group); } // idempotent retry
  if (group.status !== 'Pending') return res.status(409).json({ message: 'אפשר לסמן ״נמסר״ רק תשלום שממתין למסירה' });
  group.status = 'Handed';
  group.handedAt = new Date();
  await group.save();
  await propagateGroupState(group);
  res.json(group);
};

export const markGroupCleared = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  if (group.status === 'Cleared') { await propagateGroupState(group); return res.json(group); } // idempotent retry
  if (!['Pending', 'Handed'].includes(group.status)) return res.status(409).json({ message: 'התשלום המרוכז כבר נפרע או בוטל' });
  group.status = 'Cleared';
  group.clearedAt = new Date();
  await group.save();
  await propagateGroupState(group);
  await generateDueRentReminders(); // resolves the linked payments' reminders
  res.json(group);
};

// Durable recovery: converges any payment/group divergence left by a partial
// failure (group saved but payments not updated, or link write lost). Runs in
// the hourly maintenance alongside schedule materialization and reminders.
export const reconcileRentPaymentGroups = async () => {
  const groups = await RentPaymentGroup.find({ status: { $in: ['Pending', 'Handed', 'Cleared'] } });
  for (const group of groups) await propagateGroupState(group);
};

// ----- Record corrections: edit a pending payment, cancel a grouped payment -----
// Records only: nothing here touches a real bank account or cheque. Every
// correction keeps the original values in an append-only RentAudit entry.

export const editPayment = async (req, res) => {
  const payment = await findPayment(req, res);
  if (!payment) return;
  if (payment.status !== 'Pending') return res.status(409).json({ message: 'אפשר לערוך רק תשלום שממתין. תשלום שנמסר או נפרע נשאר לתיעוד.' });
  const before = { amount: payment.amount, dueDate: payment.dueDate };
  if (req.body.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ message: 'יש להזין סכום חיובי' });
    payment.amount = amount;
  }
  if (req.body.dueDate !== undefined) {
    if (!validDate(req.body.dueDate)) return res.status(400).json({ message: 'יש להזין תאריך פרעון תקין' });
    payment.dueDate = dayStart(req.body.dueDate);
  }
  if (payment.amount === before.amount && payment.dueDate.getTime() === new Date(before.dueDate).getTime()) {
    return res.status(400).json({ message: 'לא בוצע שינוי' });
  }
  try {
    await payment.save(); // the {agreementId, dueDate} unique key rejects a collision
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'כבר קיים תשלום לתאריך הזה בהסכם הזה' });
    throw error;
  }
  // A grouped payment's share and the group total must stay equal: the
  // correction updates the allocation and the total together.
  if (payment.groupId) {
    const group = await RentPaymentGroup.findById(payment.groupId);
    if (group && ['Pending', 'Handed'].includes(group.status)) {
      const allocation = group.allocations.find((a) => String(a.paymentId) === String(payment._id));
      if (allocation) {
        allocation.amount = payment.amount;
        group.totalAmount = group.allocations.reduce((sum, a) => sum + a.amount, 0);
        await group.save();
      }
    }
  }
  payment.lastEditedAt = new Date();
  await payment.save();
  await RentAudit.create({
    adminId: payment.adminId,
    action: 'edit_payment',
    paymentId: payment._id,
    groupId: payment.groupId || null,
    branchName: payment.branchName,
    authorityName: payment.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { amount: payment.amount, dueDate: payment.dueDate },
    createdBy: req.user._id,
  });
  res.json(payment);
};

// Cancels the RECORD of a grouped payment (the cheque was never handed, or
// the handover was cancelled before clearing). The obligations return to
// ungrouped pending payments; the cancelled group and the original values
// stay in the audit trail. A cleared group is money that moved - not
// cancellable here.
export const cancelPaymentGroup = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  if (group.status === 'Cancelled') return res.json(group); // idempotent
  if (group.status === 'Cleared') return res.status(409).json({ message: 'תשלום שכבר נפרע לא ניתן לביטול - מדובר בכסף שעבר בפועל' });
  const payments = await RentPayment.find({ groupId: group._id });
  const before = {
    status: group.status,
    totalAmount: group.totalAmount,
    allocations: group.allocations.map((a) => ({ branchName: a.branchName, amount: a.amount })),
  };
  for (const payment of payments) {
    if (['Pending', 'Handed'].includes(payment.status)) {
      payment.status = 'Pending';
      payment.groupId = null;
      payment.paidAt = null;
      await payment.save();
    }
  }
  group.status = 'Cancelled';
  group.cancelledAt = new Date();
  await group.save();
  await RentAudit.create({
    adminId: group.adminId,
    action: 'cancel_group',
    groupId: group._id,
    authorityName: group.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { status: 'Cancelled', returnedToPending: payments.length },
    createdBy: req.user._id,
  });
  await generateDueRentReminders(); // re-arms week-before reminders if the payments are due soon
  res.json(group);
};

// Records-only status reversal for a mistaken click (e.g. marked cleared by
// accident). The mistaken event is never rewritten or deleted: it stays in
// RentAudit, and the payment returns to its prior tracking state. Reverting
// never touches a real bank account or cheque.
const revertState = (doc) => {
  // Cleared returns to Handed only when a real handover was recorded (cheques);
  // transfers never pass through Handed, so they return to Pending.
  if (doc.status === 'Cleared') return doc.method === 'cheque' && doc.paidAt ? 'Handed' : 'Pending';
  if (doc.status === 'Handed') return 'Pending';
  return null;
};

const reopenReminders = async (paymentIds) => {
  await RentReminder.updateMany(
    { rentPaymentId: { $in: paymentIds }, status: 'Resolved' },
    { status: 'Open', resolvedAt: null, resolvedBy: null },
  );
};

export const revertPaymentStatus = async (req, res) => {
  const payment = await findPayment(req, res);
  if (!payment) return;
  if (payment.groupId) return res.status(409).json({ message: 'התשלום שובץ לתשלום מרוכז - ביטול הסימון מתבצע על התשלום המרוכז עצמו' });
  const target = revertState(payment);
  if (!target) return res.status(409).json({ message: 'אפשר לבטל סימון רק של תשלום שסומן כנמסר או כנפרע' });
  const before = { status: payment.status, paidAt: payment.paidAt, clearedAt: payment.clearedAt };
  payment.status = target;
  if (target === 'Pending') payment.paidAt = null;
  payment.clearedAt = null;
  await payment.save();
  await reopenReminders([payment._id]);
  await RentAudit.create({
    adminId: payment.adminId,
    action: 'revert_payment',
    paymentId: payment._id,
    branchName: payment.branchName,
    authorityName: payment.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { status: payment.status, paidAt: payment.paidAt, clearedAt: payment.clearedAt },
    createdBy: req.user._id,
  });
  res.json(payment);
};

export const revertGroupStatus = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  const target = revertState({ status: group.status, method: group.method, paidAt: group.handedAt });
  if (!target) return res.status(409).json({ message: 'אפשר לבטל סימון רק של תשלום מרוכז שסומן כנמסר או כנפרע' });
  const before = { status: group.status, handedAt: group.handedAt, clearedAt: group.clearedAt };
  group.status = target;
  if (target === 'Pending') group.handedAt = null;
  group.clearedAt = null;
  await group.save();
  const payments = await RentPayment.find({ groupId: group._id });
  for (const payment of payments) {
    if (!['Handed', 'Cleared'].includes(payment.status)) continue;
    payment.status = target;
    if (target === 'Pending') payment.paidAt = null;
    payment.clearedAt = null;
    await payment.save();
  }
  await reopenReminders(payments.map((p) => p._id));
  await RentAudit.create({
    adminId: group.adminId,
    action: 'revert_group',
    groupId: group._id,
    authorityName: group.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { status: group.status, handedAt: group.handedAt, clearedAt: group.clearedAt, paymentsReverted: payments.length },
    createdBy: req.user._id,
  });
  res.json(group);
};

// ----- Actual-paid report: what was really paid, per authority and per branch -----

// Payments are the single source of truth: every shekel of a grouped payment
// lives on exactly one allocation's payment row, so summing payments can never
// double count. The period can filter by DUE date (what had to be paid in the
// period, cleared vs outstanding) or by ACTUAL CLEAR date (money that really
// arrived in the period; outstanding is due-based and shown only in due mode).
export const getPaidReport = async (req, res) => {
  const adminId = getAdminId(req.user);
  const now = new Date();
  const from = validDate(req.query.from) ? dayStart(req.query.from) : dayStart(new Date(now.getFullYear(), 0, 1));
  const to = validDate(req.query.to) ? dayEnd(req.query.to) : dayEnd(new Date(now.getFullYear(), 11, 31));
  const byClearDate = req.query.dateField === 'cleared';
  const filter = { adminId, status: { $ne: 'Cancelled' } };
  // Cleared mode reports money that actually arrived in the period only;
  // outstanding is a due-based concept and stays in due mode.
  if (byClearDate) { filter.status = 'Cleared'; filter.clearedAt = { $gte: from, $lte: to }; }
  else filter.dueDate = { $gte: from, $lte: to };
  if (req.query.authorityId) filter.authorityId = req.query.authorityId;
  const payments = await RentPayment.find(filter).sort({ dueDate: 1 });
  const byAuthority = new Map();
  for (const payment of payments) {
    const aKey = String(payment.authorityId);
    if (!byAuthority.has(aKey)) {
      byAuthority.set(aKey, { authorityId: aKey, authorityName: payment.authorityName, clearedTotal: 0, clearedCheque: 0, clearedTransfer: 0, outstandingTotal: 0, branches: new Map() });
    }
    const bucket = byAuthority.get(aKey);
    const bKey = String(payment.branchId);
    if (!bucket.branches.has(bKey)) bucket.branches.set(bKey, { branchId: bKey, branchName: payment.branchName, clearedTotal: 0, outstandingTotal: 0, paymentCount: 0 });
    const branchBucket = bucket.branches.get(bKey);
    branchBucket.paymentCount += 1;
    if (payment.status === 'Cleared') {
      bucket.clearedTotal += payment.amount;
      branchBucket.clearedTotal += payment.amount;
      if (payment.method === 'cheque') bucket.clearedCheque += payment.amount; else bucket.clearedTransfer += payment.amount;
    } else {
      bucket.outstandingTotal += payment.amount;
      branchBucket.outstandingTotal += payment.amount;
    }
  }
  const authorities = [...byAuthority.values()]
    .map((a) => ({ ...a, branches: [...a.branches.values()].sort((x, y) => x.branchName.localeCompare(y.branchName, 'he')) }))
    .sort((x, y) => x.authorityName.localeCompare(y.authorityName, 'he'));
  res.json({ from, to, dateField: byClearDate ? 'cleared' : 'due', authorities });
};
