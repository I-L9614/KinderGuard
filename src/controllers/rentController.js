import { normName } from '../utils/normName.js';
import Authority from '../models/Authority.js';
import RentAgreement from '../models/RentAgreement.js';
import RentPayment from '../models/RentPayment.js';
import RentReminder from '../models/RentReminder.js';
import RentPaymentGroup from '../models/RentPaymentGroup.js';
import RentAudit from '../models/RentAudit.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';
import { israelToday, calendarDay, israelParts, israelMidnightInstant, israelEndOfDayInstant } from '../utils/israelTime.js';
import { uploadFileToS3, downloadFileFromS3, deleteFileFromS3 } from '../services/s3Service.js';
import { ALLOWED_UPLOAD_MIME, matchesDeclaredType } from '../utils/uploadTypes.js';

// Calendar days are UTC-midnight dates; "today" is the Israel date, not the server's.
const dayStart = (value) => (value === undefined ? israelToday() : calendarDay(value));
const dayEnd = (value) => new Date(dayStart(value).getTime() + 86400000 - 1);
// Adding months keeps the anchor day-of-month, clamping to the month's last
// day instead of overflowing into the next one (Jan 31 -> Feb 28 -> Mar 31,
// never Jan 31 -> Mar 3). Dates are UTC-midnight calendar days.
const addMonths = (value, months) => {
  const d = new Date(value);
  const target = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)));
};
const DAYS = 86400000;
// Payments are materialized this far ahead: a full year, so a monthly
// agreement shows its 12 cheques and a quarterly one its 4 from day one, and
// the hourly maintenance keeps the window sliding forward.
const SCHEDULE_HORIZON_MONTHS = 12;
const WEEK_BEFORE_DAYS = 7;
const MONTH_BEFORE_DAYS = 30;

const validDate = (value) => value && !Number.isNaN(new Date(value).getTime());

// Due amount per scheduled payment: quarterly pays its stored quarterly
// figure (default monthly x 3), annual pays the stored yearly figure, monthly
// and custom pay the monthly amount. Null when the agreement has no amount
// that fits its frequency yet.

// Atomic stale-write guard: an AI proposal (or any caller) may pin the
// agreement version it was based on. The load itself is conditional on it, and
// the schema's optimistic concurrency makes save() fail if anything wrote in
// between, so neither a manual edit nor a second confirm can be overwritten.
const loadAgreement = (req, adminId) => RentAgreement.findOne({
  _id: req.params.id, adminId, status: { $ne: 'Pending_Setup' }, ...(req.expectedUpdatedAt ? { updatedAt: req.expectedUpdatedAt } : {}),
});
const staleAgreement = (res) => res.status(409).json({ message: 'ההסכם השתנה מאז ההצעה. בקשו הצעה חדשה.' });
const isVersionError = (e) => e && (e.name === 'VersionError' || e.name === 'DocumentNotFoundError');

export const periodAmount = (agreement) => (agreement.frequency === 'quarterly'
  ? (agreement.quarterlyAmount ?? (agreement.monthlyAmount != null ? agreement.monthlyAmount * 3 : (agreement.annualAmount != null ? agreement.annualAmount / 4 : null)))
  : agreement.frequency === 'annual' ? agreement.annualAmount
    : agreement.monthlyAmount);

// Every due date the agreement's schedule should currently cover: its cadence
// from the anchor (or its custom dates) out to the 12-month horizon. Empty for
// record-only agreements (no first due date, or no amount that fits the
// frequency) - they materialize nothing, never a zero payment.
const scheduledDueDates = (agreement) => {
  if (agreement.status !== 'Active' || !agreement.firstDueDate) return [];
  if (periodAmount(agreement) == null) return [];
  const horizon = addMonths(dayStart(), SCHEDULE_HORIZON_MONTHS);
  const dates = [];
  if (agreement.frequency === 'custom') {
    for (const d of agreement.customDueDates || []) {
      const date = dayStart(d);
      if (date <= horizon) dates.push(date);
    }
    return dates;
  }
  const step = agreement.frequency === 'monthly' ? 1 : agreement.frequency === 'quarterly' ? 3 : 12;
  // Every date is computed from the anchor (first due date), not from the
  // previous date, so clamped month-ends never drift cumulatively.
  const anchor = dayStart(agreement.firstDueDate);
  for (let i = 0; ; i += 1) {
    const d = addMonths(anchor, i * step);
    if (d > horizon) break;
    dates.push(d);
  }
  return dates;
};

// Materializes scheduled payments for one agreement, idempotently (the
// {agreementId, dueDate} unique key makes re-runs no-ops for existing rows).
export const scheduleRentPayments = async (agreement) => {
  const dates = scheduledDueDates(agreement);
  if (!dates.length) return 0;
  const amount = periodAmount(agreement);
  const branch = await Branch.findById(agreement.branchId).select('name');
  const authority = await Authority.findById(agreement.authorityId).select('name');
  let created = 0;
  for (const dueDate of dates) {
    // A concurrent scheduler (hourly materialization or another request) can
    // insert the same {agreementId, dueDate} row first: the unique index then
    // rejects this upsert with 11000, which only means the row already exists.
    let result;
    try {
      result = await RentPayment.updateOne(
        { agreementId: agreement._id, dueDate },
        {
          $setOnInsert: {
            adminId: agreement.adminId,
            branchId: agreement.branchId,
            authorityId: agreement.authorityId,
            branchName: branch?.name || '',
            authorityName: authority?.name || '',
            dueDate,
            amount,
            method: agreement.paymentMethod,
            status: 'Pending',
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) continue;
      throw error;
    }
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
  const nameKey = normName(name);
  const adminId = getAdminId(req.user);
  // Read check first (covers legacy records without nameKey, which the
  // partial index cannot see). While the approved migration has not built the
  // unique index, a concurrent create can still slip past this check, so the
  // post-create reconciliation below decides deterministically: with N
  // concurrent creators the smallest id always survives and every later one
  // removes itself. Exactly one authority with a normalized name remains no
  // matter how creations interleave, with or without the index.
  const before = await Authority.find({ adminId }).select('name').lean();
  if (before.some((x) => normName(x.name) === nameKey)) return res.status(409).json({ message: 'כבר קיים גוף בשם הזה' });
  let authority;
  try { authority = await Authority.create({ adminId, name, type, nameKey }); } catch (e) { if (e?.code === 11000) return res.status(409).json({ message: 'כבר קיים גוף בשם הזה' }); throw e; }
  const after = await Authority.find({ adminId }).select('name').lean();
  if (after.some((x) => normName(x.name) === nameKey && String(x._id) < String(authority._id))) {
    await Authority.deleteOne({ _id: authority._id });
    return res.status(409).json({ message: 'כבר קיים גוף בשם הזה' });
  }
  res.status(201).json(authority);
};

export const deleteAuthority = async (req, res) => {
  const adminId = getAdminId(req.user);
  // Atomically claim the authority for deletion (same guard pattern as
  // branches): two deletes cannot interleave, and agreement creation refuses
  // or unwinds against the flag. The AI version pin joins the claim filter,
  // so a stale proposal can never delete. No delete-then-restore: a crash
  // between those two would lose the authority with its history.
  const claim = await Authority.findOneAndUpdate(
    { _id: req.params.id, adminId, deleting: { $ne: true }, ...(req.expectedUpdatedAt ? { updatedAt: req.expectedUpdatedAt } : {}) },
    { $set: { deleting: true } },
    { new: true },
  );
  if (!claim) {
    const exists = await Authority.exists({ _id: req.params.id, adminId });
    if (!exists) return res.status(404).json({ message: 'הרשות לא נמצאה' });
    if (req.expectedUpdatedAt) return res.status(409).json({ message: 'הגוף השתנה מאז ההצעה. בקשו הצעה חדשה.' });
    return res.status(409).json({ message: 'מחיקת הרשות כבר מתבצעת. נסו שוב בעוד רגע.' });
  }
  const releaseGuard = () => Authority.updateOne({ _id: claim._id }, { $set: { deleting: false } });
  // Checked after the guard is claimed: agreement creation validates against
  // the flag and unwinds any insert that raced it, so no active agreement can
  // slip in after this count.
  const active = await RentAgreement.countDocuments({ authorityId: claim._id, status: 'Active' });
  if (active > 0) {
    await releaseGuard();
    return res.status(409).json({ message: `לרשות יש ${active} הסכמי שכירות פעילים. סגרו אותם לפני מחיקת הרשות.` });
  }
  // Unlink live branches while the claim holds: a deleted payer must not
  // leave a dangling reference. A bind racing in after this cleanup is
  // refused by the deleting filter in branchFields or unwound by the
  // post-write verify in createBranch/updateBranch. A crash after the unlink
  // leaves the authority claimed-but-alive with truthful null links;
  // reconcileAuthorityDeleteGuards releases the stale claim so the authority
  // is usable or deletable again - no step here needs a compensating write.
  await Branch.updateMany({ adminId, authorityId: claim._id }, { $set: { authorityId: null } });
  // Closed agreements and payment history keep their denormalized names.
  await Authority.deleteOne({ _id: claim._id, deleting: true });
  res.json({ ok: true });
};

// Durable recovery for a delete that crashed after claiming the guard: the
// authority would otherwise stay 'deleting' forever, refusing agreements and
// deletes. Guards older than ten minutes are residue (a delete takes
// seconds); release them so the authority is usable or deletable again.
export const reconcileAuthorityDeleteGuards = async () => {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  await Authority.updateMany({ deleting: true, updatedAt: { $lt: staleBefore } }, { $set: { deleting: false } });
};

const validateAgreementInput = async (req, res) => {
  const adminId = getAdminId(req.user);
  const { branchId, authorityId, monthlyAmount, quarterlyAmount, annualAmount, frequency, firstDueDate, paymentMethod } = req.body;
  // Amounts are optional: the user adds them later. A missing amount is
  // stored as null (never zero) and no payment schedule is materialized.
  const hasMonthly = monthlyAmount !== undefined && monthlyAmount !== null && monthlyAmount !== '';
  const monthly = hasMonthly ? Number(monthlyAmount) : null;
  if (hasMonthly && !(monthly > 0)) { res.status(400).json({ message: 'יש להזין סכום חודשי חיובי' }); return null; }
  const hasQuarterly = quarterlyAmount !== undefined && quarterlyAmount !== null && quarterlyAmount !== '';
  const quarterlyInput = hasQuarterly ? Number(quarterlyAmount) : null;
  if (hasQuarterly && !(quarterlyInput >= 0)) { res.status(400).json({ message: 'הסכום הרבעוני אינו תקין' }); return null; }
  const hasAnnual = annualAmount !== undefined && annualAmount !== null && annualAmount !== '';
  const annual = hasAnnual ? Number(annualAmount) : (monthly != null ? monthly * 12 : null);
  if (hasAnnual && !(annual >= 0)) { res.status(400).json({ message: 'הסכום השנתי אינו תקין' }); return null; }
  // The quarterly figure defaults to monthly x 3, or a quarter of the yearly
  // figure when only that exists; it stays independently editable so an
  // agreed quarterly sum does not drift on monthly x 3 rounding.
  const quarterly = quarterlyInput ?? (monthly != null ? monthly * 3 : (annual != null ? annual / 4 : null));
  // Schedule fields are required once an amount exists; without an amount
  // they stay unset so nothing invented is displayed or scheduled.
  const hasAnyAmount = monthly != null || quarterly != null || annual != null;
  if (hasAnyAmount || frequency) {
    if (!['monthly', 'quarterly', 'annual', 'custom'].includes(frequency)) { res.status(400).json({ message: 'תדירות התשלום אינה תקינה' }); return null; }
  }
  if (hasAnyAmount || paymentMethod) {
    if (!['cheque', 'transfer'].includes(paymentMethod)) { res.status(400).json({ message: 'אמצעי התשלום אינו תקין' }); return null; }
  }
  // An annual agreement needs no monthly amount: the yearly figure alone
  // schedules one payment a year. Monthly and custom need the monthly figure.
  if (frequency === 'annual' && annual == null) { res.status(400).json({ message: 'בתדירות שנתית יש להזין סכום שנתי או חודשי' }); return null; }
  if (frequency === 'quarterly' && quarterly == null) { res.status(400).json({ message: 'בתדירות רבעונית יש להזין סכום רבעוני, חודשי או שנתי' }); return null; }
  if (hasAnyAmount && !validDate(firstDueDate)) { res.status(400).json({ message: 'יש להזין תאריך פרעון ראשון תקין' }); return null; }
  if (firstDueDate && !validDate(firstDueDate)) { res.status(400).json({ message: 'יש להזין תאריך פרעון ראשון תקין' }); return null; }
  const direction = req.body.direction === 'incoming' ? 'incoming' : 'outgoing';
  const branch = await Branch.findOne({ _id: branchId, adminId });
  if (!branch) { res.status(404).json({ message: 'הסניף לא נמצא' }); return null; }
  if (branch.deleting) { res.status(409).json({ message: 'הסניף בתהליך מחיקה - לא ניתן להוסיף הסכם שכירות' }); return null; }
  const authority = await Authority.findOne({ _id: authorityId, adminId });
  if (!authority) { res.status(404).json({ message: 'הרשות לא נמצאה' }); return null; }
  if (authority.deleting) { res.status(409).json({ message: 'הרשות בתהליך מחיקה - לא ניתן להוסיף הסכם שכירות' }); return null; }
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
  return { adminId, branch, authority, monthly, quarterly, annual, frequency: frequency || null, customDueDates, paymentMethod: paymentMethod || null, firstDueDate: validDate(firstDueDate) ? dayStart(firstDueDate) : null, chequeSeries, direction };
};

export const createAgreement = async (req, res) => {
  const input = await validateAgreementInput(req, res);
  if (!input) return;
  const agreement = await RentAgreement.create({
    adminId: input.adminId,
    branchId: input.branch._id,
    authorityId: input.authority._id,
    branchName: input.branch.name || '',
    authorityName: input.authority.name || '',
    direction: input.direction,
    monthlyAmount: input.monthly,
    quarterlyAmount: input.quarterly,
    annualAmount: input.annual,
    frequency: input.frequency,
    firstDueDate: input.firstDueDate,
    customDueDates: input.customDueDates,
    paymentMethod: input.paymentMethod,
    chequeSeries: input.chequeSeries,
    // A guarded (AI-path) create starts invisible: Pending_Setup + pendingGuard.
    // Every consumer that filters status:'Active' ignores it, and it has no
    // payments while pending, so nothing can act on it as a real agreement
    // before the commit below. The plain UI path is unchanged (Active at once).
    ...(req.rejectActiveDuplicate ? { status: 'Pending_Setup', pendingGuard: true } : {}),
  });
  // AI-path duplicate-Active guard (opt-in via req.rejectActiveDuplicate; the
  // plain UI keeps its existing contract and may hold several Active
  // agreements per branch+authority). There is deliberately no unique index
  // for this invariant - creating one would be a live migration - so the
  // insert itself is the claim. Any OTHER Active or still-pending agreement
  // for the same branch+authority, created before or concurrently, means this
  // insert loses: unwind it and refuse. If two racers both see each other,
  // both unwind (fail-closed; a retry then succeeds), so at most one Active
  // agreement per branch+authority ever survives on this path.
  if (req.rejectActiveDuplicate) {
    const duplicate = await RentAgreement.exists({ adminId: input.adminId, branchId: input.branch._id, authorityId: input.authority._id, status: { $in: ['Active', 'Pending_Setup'] }, _id: { $ne: agreement._id } });
    if (duplicate) {
      // If this delete fails, the loser keeps its pendingGuard flag and the
      // reconcile removes it - no duplicate is left without a recovery path.
      await RentAgreement.deleteOne({ _id: agreement._id });
      return res.status(409).json({ message: 'כבר קיים הסכם פעיל לסניף הזה מול גוף התשלום. ההסכם לא נוצר.' });
    }
  }
  // Close the delete race deterministically: the authority may have been
  // claimed for deletion (or deleted) between validation and this insert. If
  // so, the new agreement must not survive pointing at a gone authority -
  // unwind it and refuse. Together with the deleting-flag check above, every
  // interleaving ends consistent: either the delete sees the agreement and
  // refuses, or the agreement unwinds itself. No dangling reference is ever
  // left, before or after the delete's own checks.
  const authorityAlive = await Authority.exists({ _id: input.authority._id, deleting: { $ne: true } });
  if (!authorityAlive) {
    await RentAgreement.deleteOne({ _id: agreement._id });
    return res.status(409).json({ message: 'הרשות נמחקה בינתיים. ההסכם לא נוצר.' });
  }
  if (req.rejectActiveDuplicate) {
    // Commit point of the guarded create: checks passed. Only now does the
    // row become a real (Active) agreement - one atomic conditional write,
    // still gated on the flag so a swept row can never resurrect. Anything
    // after this is convergent: a crash before or during scheduling is
    // completed by the startup/hourly scheduleAllRentPayments (idempotent
    // upserts) and generateDueRentReminders, exactly as for any Active row.
    const committed = await RentAgreement.updateOne({ _id: agreement._id, pendingGuard: true }, { $set: { status: 'Active' }, $unset: { pendingGuard: 1 } });
    if (!committed.modifiedCount) throw Object.assign(new Error('ההסכם לא נוצר. נסו שוב.'), { statusCode: 500 });
    agreement.set({ status: 'Active', pendingGuard: undefined });
  }
  await scheduleRentPayments(agreement);
  await generateDueRentReminders();
  res.status(201).json(agreement);
};

// Recovery for guarded (AI-path) creates: a row still flagged pendingGuard
// is stuck in Pending_Setup - its create never returned success (the commit
// above flips Active rows and clears the flag first), it has no payments in
// the normal flow, and consumers filtering status:'Active' never see it.
// Deleting it (plus any children, defensively) is always truthful and lets a
// retry start clean. Only stale rows are touched: a live create finishes in
// milliseconds, well under the age threshold. Plain-UI agreements never carry
// the flag, so intentionally multi-agreement pairs are never swept.
export const reconcileGuardedAgreementCreates = async () => {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  // Every Pending_Setup row is a guarded create, and an aged one is a dead
  // create. Rows claimed by an earlier pass that crashed mid-cleanup are
  // included so the next pass resumes them.
  const stale = await RentAgreement.find({ status: 'Pending_Setup', createdAt: { $lt: staleBefore } }).select('_id sweepClaim').lean();
  let swept = 0;
  for (const s of stale) {
    if (!s.sweepClaim) {
      // Conditional claim: unsetting pendingGuard atomically fences out a
      // writer resuming after the age threshold - its commit requires
      // pendingGuard:true and now matches nothing, so it fails closed instead
      // of activating a row whose children are being deleted. If the commit
      // landed first, matchedCount is 0 and the row is Active: hands off.
      const claim = await RentAgreement.updateOne({ _id: s._id, pendingGuard: true }, { $set: { sweepClaim: true }, $unset: { pendingGuard: 1 } });
      if (claim.matchedCount === 0) continue;
    }
    // Agreement LAST: a crash here leaves orphaned children for the next
    // pass, never an agreement whose payments silently vanished.
    await RentReminder.deleteMany({ rentAgreementId: s._id });
    await RentPayment.deleteMany({ agreementId: s._id });
    const del = await RentAgreement.deleteOne({ _id: s._id, status: 'Pending_Setup' });
    if (del.deletedCount) swept += 1;
  }
  return swept;
};

// --- Rent agreement documents (kept separate from license documents) ---

const findAgreement = async (req) => {
  // Pending_Setup rows are uncommitted guarded creates: not addressable by id
  // on any direct route (documents, update, close) - they answer 404 like any
  // row that does not exist for this admin.
  const agreement = await RentAgreement.findOne({ _id: req.params.id, adminId: getAdminId(req.user), status: { $ne: 'Pending_Setup' }, ...(req.expectedUpdatedAt ? { updatedAt: req.expectedUpdatedAt } : {}) });
  return agreement;
};

export const uploadAgreementDocument = async (req, res) => {
  const agreement = await findAgreement(req);
  if (!agreement) {
    if (req.expectedUpdatedAt && await RentAgreement.exists({ _id: req.params.id, adminId: getAdminId(req.user), status: { $ne: 'Pending_Setup' } })) return staleAgreement(res);
    return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  }
  if (!req.file) return res.status(400).json({ message: 'לא נבחר קובץ להעלאה' });
  // The declared mimetype passed the route whitelist; now prove the bytes
  // match it, so a renamed script can't ride into storage as a "document".
  if (!matchesDeclaredType(req.file.buffer, req.file.mimetype)) {
    const error = new Error('תוכן הקובץ אינו תואם את סוג הקובץ. העלו PDF או תמונה תקינים.');
    error.statusCode = 400;
    error.publicMessage = error.message;
    throw error;
  }
  let key;
  try {
    key = await uploadFileToS3(req.file.buffer, req.file.originalname, req.file.mimetype, 'rent');
  } catch (error) {
    error.statusCode = 502;
    error.publicMessage = 'המסמך לא הועלה לאחסון. בדקו את החיבור ונסו שוב.';
    throw error;
  }
  agreement.documents.push({ key, fileName: req.file.originalname || '', uploadedAt: new Date(), uploadedBy: req.user._id });
  // A concurrent write since the load must reject this save, not crash it:
  // the version guard maps to 409 so the client can reload and retry. The
  // already-uploaded S3 object stays orphaned, never a dangling DB reference.
  try { await agreement.save(); } catch (e) { if (isVersionError(e)) return staleAgreement(res); throw e; }
  res.status(201).json(agreement.documents[agreement.documents.length - 1]);
};

export const downloadAgreementDocument = async (req, res) => {
  const agreement = await findAgreement(req);
  if (!agreement) return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  const doc = agreement.documents.id(req.params.docId);
  if (!doc) return res.status(404).json({ message: 'המסמך לא נמצא' });

  let s3Response;
  try {
    s3Response = await downloadFileFromS3(doc.key);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ message: 'הקובץ לא נמצא באחסון. ייתכן שהוא הוסר.' });
    }
    error.statusCode = 502;
    error.publicMessage = 'שירות האחסון אינו זמין כרגע. נסו שוב בעוד רגע.';
    throw error;
  }

  const fileName = doc.fileName || 'rent-document';
  const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  // Only known document/image types render inline. Anything else downloads as
  // an opaque attachment, never as an active page on our origin.
  const storedType = s3Response.ContentType || 'application/octet-stream';
  const safeInline = ALLOWED_UPLOAD_MIME.has(storedType);
  res.setHeader('Content-Type', safeInline ? storedType : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (s3Response.ContentLength) res.setHeader('Content-Length', String(s3Response.ContentLength));
  s3Response.Body.pipe(res);
};

// Deleting a rent document is an explicit per-document action: the agreement
// and its payments stay untouched.
export const deleteAgreementDocument = async (req, res) => {
  const agreement = await findAgreement(req);
  if (!agreement) return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  const doc = agreement.documents.id(req.params.docId);
  if (!doc) return res.status(404).json({ message: 'המסמך לא נמצא' });
  // Commit the reference removal first: the version-guarded save is the
  // atomic commit, so a concurrent write yields 409 with the file and its
  // reference both intact. The S3 object is deleted only afterwards; an S3
  // failure there leaves an orphan file (storage cost), never a dangling
  // reference to an already-deleted object.
  doc.deleteOne();
  try { await agreement.save(); } catch (e) { if (isVersionError(e)) return staleAgreement(res); throw e; }
  try {
    await deleteFileFromS3(doc.key);
  } catch (error) {
    console.warn('rent document removed from agreement but S3 delete failed:', doc.key, error?.message || error);
  }
  res.json({ message: 'המסמך נמחק' });
};

export const updateAgreement = async (req, res) => {
  const adminId = getAdminId(req.user);
  const agreement = await loadAgreement(req, adminId);
  if (!agreement) {
    if (req.expectedUpdatedAt && await RentAgreement.exists({ _id: req.params.id, adminId, status: { $ne: 'Pending_Setup' } })) return staleAgreement(res);
    return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  }
  const frequencyBefore = agreement.frequency;
  const firstDueBefore = agreement.firstDueDate ? dayStart(agreement.firstDueDate).getTime() : null;
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
    if (body.quarterlyAmount === undefined && agreement.quarterlyAmount == null) agreement.quarterlyAmount = monthly * 3;
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
  if (body.annualAmount !== undefined && body.annualAmount !== '') {
    const annual = Number(body.annualAmount);
    if (!(annual >= 0)) return res.status(400).json({ message: 'הסכום השנתי אינו תקין' });
    agreement.annualAmount = annual;
  }
  if (body.quarterlyAmount !== undefined && body.quarterlyAmount !== '') {
    const quarterly = Number(body.quarterlyAmount);
    if (!(quarterly >= 0)) return res.status(400).json({ message: 'הסכום הרבעוני אינו תקין' });
    agreement.quarterlyAmount = quarterly;
  }
  const hasAnyAmount = agreement.monthlyAmount != null || agreement.annualAmount != null || agreement.quarterlyAmount != null;
  if (hasAnyAmount && (!agreement.frequency || !agreement.paymentMethod || !agreement.firstDueDate)) {
    return res.status(400).json({ message: 'עם סכום יש להזין גם תדירות, אמצעי תשלום ותאריך פרעון ראשון' });
  }
  if (hasAnyAmount && periodAmount(agreement) == null) {
    return res.status(400).json({ message: 'לתדירות שנבחרה יש להזין סכום מתאים' });
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
  const amountsChanged = body.monthlyAmount !== undefined || body.annualAmount !== undefined || body.quarterlyAmount !== undefined;
  const scheduleChanged = agreement.frequency !== frequencyBefore
    || (agreement.firstDueDate ? agreement.firstDueDate.getTime() : null) !== firstDueBefore;
  try { await agreement.save(); } catch (e) { if (isVersionError(e)) return staleAgreement(res); throw e; }
  // Reconcile before materializing so removed dates do not block the new
  // schedule's unique {agreementId, dueDate} rows.
  if (scheduleChanged) await reconcileScheduleChange(agreement);
  await scheduleRentPayments(agreement);
  if (amountsChanged || scheduleChanged) await syncPendingPaymentAmounts(agreement);
  await generateDueRentReminders();
  res.json(agreement);
};

// After the cadence or its anchor (first due date) changes, generated future
// rows that no longer fit the schedule are removed: only Pending, ungrouped
// payments the user never edited, due today or later. Each removal is
// audited so the original row survives in the trail. Past-due rows (even
// untouched) are real outstanding records and stay; handed, cleared, grouped
// and manually edited payments never move.
const reconcileScheduleChange = async (agreement) => {
  const keep = new Set(scheduledDueDates(agreement).map((d) => d.getTime()));
  const stale = await RentPayment.find({
    agreementId: agreement._id,
    status: 'Pending',
    groupId: null,
    lastEditedAt: null,
    dueDate: { $gte: dayStart() },
  });
  let removed = 0;
  for (const payment of stale) {
    if (keep.has(payment.dueDate.getTime())) continue;
    // Conditional delete: the row still has to match every qualifier it was
    // selected under. A handover, manual edit or grouping that landed after
    // the load makes the delete miss instead of erasing a real obligation.
    const deleted = await RentPayment.deleteOne({ _id: payment._id, status: 'Pending', groupId: null, lastEditedAt: null });
    if (!deleted.deletedCount) continue;
    await RentAudit.create({
      adminId: payment.adminId,
      action: 'sync_agreement_schedule',
      paymentId: payment._id,
      branchName: payment.branchName,
      authorityName: payment.authorityName,
      reason: 'תדירות התשלום או מועד הפרעון הראשון של ההסכם עודכנו',
      before: { status: payment.status, amount: payment.amount, dueDate: payment.dueDate },
      after: { removed: true },
    });
    removed += 1;
  }
  return removed;
};

// After an agreement's amounts change, its untouched future payments follow
// the new figure. Only ungrouped Pending payments the user never edited move:
// handed/cleared cheques, manual corrections and grouped allocations are real
// obligations and stay exactly as recorded. Each moved payment gets an audit
// entry so the original amount survives.
const syncPendingPaymentAmounts = async (agreement) => {
  const amount = periodAmount(agreement);
  if (amount == null) return 0;
  const pending = await RentPayment.find({ agreementId: agreement._id, status: 'Pending', groupId: null, lastEditedAt: null });
  let synced = 0;
  for (const payment of pending) {
    if (payment.amount === amount) continue;
    const before = { amount: payment.amount, dueDate: payment.dueDate };
    // Conditional write under the same qualifiers as the load: a handover,
    // manual edit or grouping that landed meanwhile is never overwritten back
    // to Pending by this sync.
    const updated = await RentPayment.updateOne(
      { _id: payment._id, status: 'Pending', groupId: null, lastEditedAt: null },
      { $set: { amount } },
    );
    if (!updated.modifiedCount) continue;
    await RentAudit.create({
      adminId: payment.adminId,
      action: 'sync_agreement_amounts',
      paymentId: payment._id,
      branchName: payment.branchName,
      authorityName: payment.authorityName,
      reason: 'סכום ההסכם עודכן',
      before,
      after: { amount, dueDate: payment.dueDate },
    });
    synced += 1;
  }
  return synced;
};

// Closing an agreement (by the user or by deletion recovery) cancels only
// payments nothing was handed over for. A cancelled payment is pulled out of
// its grouped payment (the group total shrinks; an emptied group cancels).
// Handed-but-uncleared cheques stay open obligations with their reminders.
export const cancelScheduledPayments = async (agreementId) => {
  const pending = await RentPayment.find({ agreementId, status: 'Pending' });
  const cancelled = [];
  for (const payment of pending) {
    // Conditional transition: a handover that landed after the load keeps the
    // payment out of the cancellation instead of being overwritten by it.
    const updated = await RentPayment.updateOne({ _id: payment._id, status: 'Pending' }, { $set: { status: 'Cancelled' } });
    if (!updated.modifiedCount) continue;
    cancelled.push(payment._id);
    if (!payment.groupId) continue;
    // Shrink the group atomically: $pull the allocation and $inc the total by
    // the payment amount (allocation.amount always equals it), so a concurrent
    // group write in between is never clobbered by a stale whole-doc save.
    const group = await RentPaymentGroup.findOneAndUpdate(
      { _id: payment.groupId, status: { $in: ['Pending', 'Handed'] } },
      { $pull: { allocations: { paymentId: payment._id } }, $inc: { totalAmount: -payment.amount } },
      { new: true },
    );
    if (group && !group.allocations.length) {
      await RentPaymentGroup.updateOne(
        { _id: group._id, status: { $in: ['Pending', 'Handed'] } },
        { $set: { status: 'Cancelled', cancelledAt: new Date() } },
      );
    }
  }
  return cancelled;
};

export const closeAgreement = async (req, res) => {
  const adminId = getAdminId(req.user);
  const agreement = await loadAgreement(req, adminId);
  if (!agreement) {
    if (req.expectedUpdatedAt && await RentAgreement.exists({ _id: req.params.id, adminId, status: { $ne: 'Pending_Setup' } })) return staleAgreement(res);
    return res.status(404).json({ message: 'הסכם השכירות לא נמצא' });
  }
  if (agreement.status === 'Closed') return res.json(agreement);
  agreement.status = 'Closed';
  agreement.closedAt = new Date();
  try { await agreement.save(); } catch (e) { if (isVersionError(e)) return staleAgreement(res); throw e; }
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
  // Atomic conditional transition (same pattern as revert): a concurrent
  // edit, cancellation or schedule sync loses with a 409 instead of being
  // overwritten by a whole-doc save.
  const updated = await RentPayment.findOneAndUpdate(
    { _id: payment._id, status: 'Pending' },
    { $set: { status: 'Handed', paidAt: new Date() } },
    { new: true },
  );
  if (!updated) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  res.json(updated);
};

export const markPaymentCleared = async (req, res) => {
  const payment = await findPayment(req, res);
  if (!payment) return;
  if (payment.groupId) return res.status(409).json({ message: 'התשלום שובץ לתשלום מרוכז - מסירה ופרעון מסומנים על התשלום המרוכז עצמו' });
  if (!['Pending', 'Handed'].includes(payment.status)) return res.status(409).json({ message: 'התשלום כבר נפרע או בוטל' });
  const clearedAt = new Date();
  const updated = await RentPayment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['Pending', 'Handed'] } },
    [{ $set: { status: 'Cleared', clearedAt, paidAt: { $ifNull: ['$paidAt', clearedAt] } } }],
    { new: true },
  );
  if (!updated) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  await generateDueRentReminders(); // resolves this payment's week-before reminder
  res.json(updated);
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
  // Pending_Setup rows are guarded AI creates that have not committed (or
  // crashed before committing): they must not render as real agreements.
  const visible = agreements.filter((a) => a.status !== 'Pending_Setup');
  const totals = {};
  for (const agreement of active) {
    const key = String(agreement.authorityId?._id || agreement.authorityId);
    totals[key] = totals[key] || { monthly: 0, annual: 0 };
    // Normalized figures per frequency: an annual agreement contributes its
    // yearly sum / 12 to the monthly total (not whatever sits in the monthly
    // field), a quarterly one its quarterly sum / 3. The yearly total stays
    // the stored annual figure, derived when absent.
    const annualFig = agreement.annualAmount ?? (agreement.monthlyAmount != null ? agreement.monthlyAmount * 12 : (agreement.quarterlyAmount != null ? agreement.quarterlyAmount * 4 : 0));
    const monthlyFig = agreement.frequency === 'annual' ? annualFig / 12
      : agreement.frequency === 'quarterly' ? ((agreement.quarterlyAmount ?? (agreement.monthlyAmount != null ? agreement.monthlyAmount * 3 : annualFig / 4)) / 3)
        : (agreement.monthlyAmount ?? annualFig / 12);
    totals[key].monthly += monthlyFig;
    totals[key].annual += annualFig;
  }
  for (const key of Object.keys(totals)) {
    totals[key].monthly = Math.round(totals[key].monthly * 100) / 100;
    totals[key].annual = Math.round(totals[key].annual * 100) / 100;
  }
  res.json({ authorities, agreements: visible, payments, groups, totals });
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
  // Conditional claim, one atomic write per payment: a concurrent grouping of
  // an overlapping payment loses. The pre-checks above only produce better
  // messages; this claim is what serializes the race.
  const claimed = await RentPayment.updateMany({ _id: { $in: ids }, status: 'Pending', groupId: null }, { $set: { groupId: group._id } });
  if (claimed.modifiedCount !== ids.length) {
    // Unwind exactly what this attempt claimed, drop the orphan group, refuse.
    await RentPayment.updateMany({ _id: { $in: ids }, groupId: group._id }, { $set: { groupId: null } });
    await RentPaymentGroup.deleteOne({ _id: group._id });
    return res.status(409).json({ message: 'חלק מהתשלומים כבר שובצו לתשלום מרוכז אחר' });
  }
  res.status(201).json(group);
};

const findGroup = async (req, res) => {
  const group = await RentPaymentGroup.findOne({ _id: req.params.id, adminId: getAdminId(req.user) });
  if (!group) { res.status(404).json({ message: 'התשלום המרוכז לא נמצא' }); return null; }
  return group;
};

// The group document is the source of truth for its payments' state: every
// linked payment must match it. Filters target the states that still need the
// transition, so a retried call after a partial failure finishes the
// remaining payments, a duplicate call is a harmless no-op, and payments left
// behind by a crashed revert converge back to the group's state.
const propagateGroupState = async (group) => {
  if (group.status === 'Handed') {
    await RentPayment.updateMany(
      { groupId: group._id, status: { $in: ['Pending', 'Cleared'] } },
      { $set: { status: 'Handed', paidAt: group.handedAt, clearedAt: null } },
    );
  } else if (group.status === 'Cleared') {
    await RentPayment.updateMany(
      { groupId: group._id, status: { $in: ['Pending', 'Handed'] } },
      [{ $set: { status: 'Cleared', clearedAt: group.clearedAt, paidAt: { $ifNull: ['$paidAt', group.clearedAt] } } }],
    );
  } else if (group.status === 'Pending') {
    await RentPayment.updateMany(
      { groupId: group._id, status: { $in: ['Handed', 'Cleared'] } },
      { $set: { status: 'Pending', paidAt: null, clearedAt: null } },
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
  // Atomic conditional transition: a clearing or cancellation that landed
  // after the load loses with a 409 instead of being overwritten back.
  const updated = await RentPaymentGroup.findOneAndUpdate(
    { _id: group._id, status: 'Pending' },
    { $set: { status: 'Handed', handedAt: new Date() } },
    { new: true },
  );
  if (!updated) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  await propagateGroupState(updated);
  res.json(updated);
};

export const markGroupCleared = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  if (group.status === 'Cleared') { await propagateGroupState(group); return res.json(group); } // idempotent retry
  if (!['Pending', 'Handed'].includes(group.status)) return res.status(409).json({ message: 'התשלום המרוכז כבר נפרע או בוטל' });
  const updated = await RentPaymentGroup.findOneAndUpdate(
    { _id: group._id, status: { $in: ['Pending', 'Handed'] } },
    { $set: { status: 'Cleared', clearedAt: new Date() } },
    { new: true },
  );
  if (!updated) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  await propagateGroupState(updated);
  await generateDueRentReminders(); // resolves the linked payments' reminders
  res.json(updated);
};

// Durable recovery: converges any payment/group divergence left by a partial
// failure (group saved but payments not updated, or link write lost). Runs in
// the hourly maintenance alongside schedule materialization and reminders.
export const reconcileRentPaymentGroups = async () => {
  const groups = await RentPaymentGroup.find({ status: { $in: ['Pending', 'Handed', 'Cleared'] } });
  for (const group of groups) await propagateGroupState(group);
  // A group cancel commits before its payment unlink; a crash between leaves
  // payments linked to a cancelled group and unactionable. Return them to
  // Pending here so the divergence always heals.
  const cancelledGroups = await RentPaymentGroup.find({ status: 'Cancelled' }).select('_id');
  if (cancelledGroups.length) {
    await RentPayment.updateMany(
      { groupId: { $in: cancelledGroups.map((g) => g._id) }, status: { $in: ['Pending', 'Handed'] } },
      { $set: { status: 'Pending', groupId: null, paidAt: null } },
    );
  }
};

// ----- Record corrections: edit a pending payment, cancel a grouped payment -----
// Records only: nothing here touches a real bank account or cheque. Every
// correction keeps the original values in an append-only RentAudit entry.

export const editPayment = async (req, res) => {
  const payment = await findPayment(req, res);
  if (!payment) return;
  if (payment.status !== 'Pending') return res.status(409).json({ message: 'אפשר לערוך רק תשלום שממתין. תשלום שנמסר או נפרע נשאר לתיעוד.' });
  const before = { amount: payment.amount, dueDate: payment.dueDate };
  const update = {};
  if (req.body.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ message: 'יש להזין סכום חיובי' });
    update.amount = amount;
  }
  if (req.body.dueDate !== undefined) {
    if (!validDate(req.body.dueDate)) return res.status(400).json({ message: 'יש להזין תאריך פרעון תקין' });
    update.dueDate = dayStart(req.body.dueDate);
  }
  const nextAmount = update.amount !== undefined ? update.amount : before.amount;
  const nextDueDate = update.dueDate !== undefined ? update.dueDate : before.dueDate;
  if (nextAmount === before.amount && new Date(nextDueDate).getTime() === new Date(before.dueDate).getTime()) {
    return res.status(400).json({ message: 'לא בוצע שינוי' });
  }
  // One atomic conditional write: the status filter is the commit guard, so a
  // handover or clearing racing this edit rejects the edit (409) instead of
  // the edit silently resurrecting the payment back to Pending.
  let saved;
  try {
    saved = await RentPayment.findOneAndUpdate(
      // Optional precondition (AI confirm path): amount, due date and ungrouped state the user approved are pinned at the commit itself.
      { _id: payment._id, adminId: payment.adminId, status: 'Pending', ...(req.expectedPayment ? { amount: req.expectedPayment.amount, dueDate: req.expectedPayment.dueDate, groupId: null } : {}) },
      { $set: { ...update, lastEditedAt: new Date() } },
      { new: true }
    ); // the {agreementId, dueDate} unique key rejects a collision
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'כבר קיים תשלום לתאריך הזה בהסכם הזה' });
    throw error;
  }
  if (!saved) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  // A grouped payment's share and the group total must stay equal: the
  // correction updates the allocation and the total together.
  if (payment.groupId) {
    const group = await RentPaymentGroup.findById(payment.groupId);
    if (group && ['Pending', 'Handed'].includes(group.status)) {
      const allocation = group.allocations.find((a) => String(a.paymentId) === String(saved._id));
      if (allocation) {
        allocation.amount = saved.amount;
        group.totalAmount = group.allocations.reduce((sum, a) => sum + a.amount, 0);
        await group.save();
      }
    }
  }
  await RentAudit.create({
    adminId: payment.adminId,
    action: 'edit_payment',
    paymentId: payment._id,
    groupId: payment.groupId || null,
    branchName: payment.branchName,
    authorityName: payment.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { amount: saved.amount, dueDate: saved.dueDate },
    createdBy: req.user._id,
  });
  res.json(saved);
};

// Cancels the RECORD of a grouped payment (the cheque was never handed, or
// the handover was cancelled before clearing). The obligations return to
// ungrouped pending payments; the cancelled group and the original values
// stay in the audit trail. A cleared group is money that moved - not
// cancellable here.
export const cancelPaymentGroup = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  if (group.status === 'Cancelled') {
    // Idempotent retry converges a partial cancel (group committed, payment
    // unlink lost to a crash): finish returning the payments to Pending.
    await RentPayment.updateMany(
      { groupId: group._id, status: { $in: ['Pending', 'Handed'] } },
      { $set: { status: 'Pending', groupId: null, paidAt: null } },
    );
    return res.json(group);
  }
  if (group.status === 'Cleared') return res.status(409).json({ message: 'תשלום שכבר נפרע לא ניתן לביטול - מדובר בכסף שעבר בפועל' });
  const payments = await RentPayment.find({ groupId: group._id });
  const before = {
    status: group.status,
    totalAmount: group.totalAmount,
    allocations: group.allocations.map((a) => ({ branchName: a.branchName, amount: a.amount })),
  };
  // Conditional group transition first: a clearing that landed after the load
  // is money that moved, so the cancel loses with a 409 instead of erasing it.
  const cancelled = await RentPaymentGroup.findOneAndUpdate(
    { _id: group._id, status: { $in: ['Pending', 'Handed'] } },
    { $set: { status: 'Cancelled', cancelledAt: new Date() } },
    { new: true },
  );
  if (!cancelled) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  // Only payments still in a live state return to Pending; one that raced to
  // Cleared meanwhile is real money and stays untouched.
  const returned = await RentPayment.updateMany(
    { groupId: group._id, status: { $in: ['Pending', 'Handed'] } },
    { $set: { status: 'Pending', groupId: null, paidAt: null } },
  );
  await RentAudit.create({
    adminId: group.adminId,
    action: 'cancel_group',
    groupId: group._id,
    authorityName: group.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { status: 'Cancelled', returnedToPending: returned.modifiedCount },
    createdBy: req.user._id,
  });
  await generateDueRentReminders(); // re-arms week-before reminders if the payments are due soon
  res.json(cancelled);
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
  // Atomic conditional write: the transition applies only if the payment is
  // still in the state the target was derived from. A concurrent mutation
  // (AI retry, another admin, a UI double-click) loses the race with a 409
  // instead of running the transition a second time.
  const updated = await RentPayment.findOneAndUpdate(
    { _id: payment._id, status: payment.status },
    { $set: { status: target, paidAt: target === 'Pending' ? null : payment.paidAt, clearedAt: null } },
    { new: true },
  );
  if (!updated) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  await reopenReminders([payment._id]);
  await RentAudit.create({
    adminId: payment.adminId,
    action: 'revert_payment',
    paymentId: payment._id,
    branchName: payment.branchName,
    authorityName: payment.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { status: updated.status, paidAt: updated.paidAt, clearedAt: updated.clearedAt },
    createdBy: req.user._id,
  });
  res.json(updated);
};

export const revertGroupStatus = async (req, res) => {
  const group = await findGroup(req, res);
  if (!group) return;
  const target = revertState({ status: group.status, method: group.method, paidAt: group.handedAt });
  if (!target) {
    // Retry convergence: a previous revert may have committed the group and
    // crashed before its payments followed. Heal them to the group's state
    // (the same rule the hourly reconcile applies) before refusing.
    await propagateGroupState(group);
    return res.status(409).json({ message: 'אפשר לבטל סימון רק של תשלום מרוכז שסומן כנמסר או כנפרע' });
  }
  const before = { status: group.status, handedAt: group.handedAt, clearedAt: group.clearedAt };
  const updatedGroup = await RentPaymentGroup.findOneAndUpdate(
    { _id: group._id, status: group.status },
    { $set: { status: target, handedAt: target === 'Pending' ? null : group.handedAt, clearedAt: null } },
    { new: true },
  );
  if (!updatedGroup) return res.status(409).json({ message: 'התשלום השתנה בינתיים. רעננו ונסו שוב.' });
  const payments = await RentPayment.find({ groupId: group._id });
  // The payments follow the group's new state through the same convergent
  // propagation the hourly reconcile runs, so a crash after the commit is
  // healed on the next reconcile or retry instead of diverging permanently.
  await propagateGroupState(updatedGroup);
  await reopenReminders(payments.map((p) => p._id));
  await RentAudit.create({
    adminId: group.adminId,
    action: 'revert_group',
    groupId: group._id,
    authorityName: group.authorityName,
    reason: String(req.body.reason || '').trim(),
    before,
    after: { status: updatedGroup.status, handedAt: updatedGroup.handedAt, clearedAt: updatedGroup.clearedAt, paymentsReverted: payments.length },
    createdBy: req.user._id,
  });
  res.json(updatedGroup);
};

// ----- Actual-paid report: what was really paid, per authority and per branch -----

// Payments are the single source of truth: every shekel of a grouped payment
// lives on exactly one allocation's payment row, so summing payments can never
// double count. The period can filter by DUE date (what had to be paid in the
// period, cleared vs outstanding) or by ACTUAL CLEAR date (money that really
// arrived in the period; outstanding is due-based and shown only in due mode).
export const getPaidReport = async (req, res) => {
  const adminId = getAdminId(req.user);
  const year = israelParts().year;
  const fromDay = validDate(req.query.from) ? dayStart(req.query.from) : new Date(Date.UTC(year, 0, 1));
  const toDay = validDate(req.query.to) ? dayStart(req.query.to) : new Date(Date.UTC(year, 11, 31));
  const byClearDate = req.query.dateField === 'cleared';
  // Due dates are stored as calendar days (UTC midnight); clear times are real
  // instants, so that mode uses the Israel day boundaries.
  const from = byClearDate ? israelMidnightInstant(fromDay) : fromDay;
  const to = byClearDate ? israelEndOfDayInstant(toDay) : dayEnd(toDay);
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
