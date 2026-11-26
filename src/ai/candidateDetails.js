import Branch from '../models/Branch.js';
import Authority from '../models/Authority.js';
import License from '../models/License.js';
import { normName } from '../utils/normName.js';

// When two choice candidates carry the same name, the user cannot choose between identical radios and a bound id does not
// tell us which one they mean. Add existing, grounded distinguishing metadata (branch: address, manager, phone; payer: kind)
// to the colliding candidates only. If the metadata still does not separate them, the whole action is refused with a plain
// Hebrew message asking for a rename. Raw ids are never shown as the identifier. Nothing is written here.
const STATUS = { Active: 'פעיל', Pending_License: 'ממתין לאישור', Suspended: 'מושהה' };
// Order is fixed: address, manager, phone, status, payer. Status always has a value, so two same-named branches differ only when something grounded differs.
export const branchDetail = (b, payerName = '') => [b.address && String(b.address).trim(), b.managerName && `מנהל/ת: ${String(b.managerName).trim()}`, b.phone && `טלפון: ${String(b.phone).trim()}`, `סטטוס: ${STATUS[b.status || 'Active'] || b.status}`, payerName && `גוף משלם: ${payerName}`].filter(Boolean).join(' · ');
export const licenseDetail = (br, fileName) => [br?.address && String(br.address).trim(), br?.managerName && `מנהל/ת: ${String(br.managerName).trim()}`, fileName ? `קובץ: ${fileName}` : 'אין קובץ מצורף'].filter(Boolean).join(' · ');
export const authorityDetail = (x) => (x.type === 'private' ? 'בעל נכס פרטי' : 'רשות');
const LABEL = { branch: 'סניפים', authority: 'גופי תשלום' };

const resolveList = async (adminId, list, kind) => {
  if (!Array.isArray(list) || list.length < 2) return null;
  const groups = new Map();
  for (const c of list) { const k = normName(c.name); groups.set(k, [...(groups.get(k) || []), c]); }
  const colliding = [...groups.values()].filter((g) => g.length > 1);
  if (!colliding.length) return null;
  const ids = colliding.flat().map((c) => c.id);
  const docs = await (kind === 'authority' ? Authority : Branch).find({ _id: { $in: ids }, adminId }).select('name address managerName phone type status authorityId').lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const pn = new Map(); if (kind === 'branch') { const aus = await Authority.find({ _id: { $in: docs.map((d) => d.authorityId).filter(Boolean) }, adminId }).select('name').lean(); for (const x of aus) pn.set(String(x._id), x.name); }
  for (const g of colliding) {
    const details = g.map((c) => { const d = byId.get(String(c.id)); return d ? (kind === 'authority' ? authorityDetail(d) : branchDetail(d, d.authorityId ? pn.get(String(d.authorityId)) || '' : '')) : ''; });
    if (details.some((x) => !x) || new Set(details).size !== details.length) return `יש כמה ${LABEL[kind]} בשם "${g[0].name}" ואין ביניהם פרט מבדיל במערכת (${kind === 'branch' ? 'כתובת, שם מנהל, טלפון, סטטוס או גוף משלם' : 'סוג'}). שנו שם של אחד מהם ואז נסו שוב. לא נוצרה הצעה`;
    g.forEach((c, i) => { c.detail = details[i]; });
  }
  return null;
};

export const disambiguateActions = async (adminId, actions, rejected) => {
  const out = [];
  for (const a of actions) {
    if (!a.needsChoice) { out.push(a); continue; }
    const payer = a.choiceField === 'agreementPayer' || a.choiceField === 'branchPayer' || a.choiceField === 'authorityId';
    if (a.choiceField === 'licenseId') {
      const bids = [...new Set((a.candidates || []).map((c) => c.bid).filter(Boolean))];
      const brs = new Map((bids.length ? await Branch.find({ _id: { $in: bids }, adminId }).select('address managerName').lean() : []).map((b) => [String(b._id), b]));
      const groups = new Map(); for (const c of a.candidates || []) groups.set(normName(c.name), [...(groups.get(normName(c.name)) || []), c]);
      let bad = null; for (const g of groups.values()) { if (g.length < 2) continue; const ds = g.map((c) => licenseDetail(brs.get(String(c.bid)), c.fields?.fileName)); if (new Set(ds).size !== ds.length) { bad = `יש כמה אישורים זהים בתיאור שלהם: "${g[0].name}", ואין ביניהם פרט מבדיל במערכת (כתובת הסניף, מנהל או קובץ מצורף). הצעה לא נוצרה. טפלו באחד מהם ידנית או שנו את הנתונים ואז נסו שוב`; break; } g.forEach((c, i) => { c.detail = ds[i]; }); }
      if (bad) { rejected.push(bad); continue; } out.push(a); continue;
    }
    const err = (await resolveList(adminId, a.candidates, payer ? 'authority' : 'branch')) || (await resolveList(adminId, a.payerCandidates, 'authority'));
    if (err) { rejected.push(err); continue; }
    out.push(a);
  }
  return out;
};

// At commit time the chosen candidate's displayed identity must still be what the user saw: a changed address, manager, phone,
// status or payer means the choice is regenerated, not honoured by name alone. Same account only (adminId-scoped lookups).
export const verifyChoiceDetail = async (adminId, a) => {
  const checks = [];
  if (a.choiceDetail) {
    if (a.choiceField === 'agreementPayer' || a.choiceField === 'authorityId') checks.push(['authority', a.authorityId, a.choiceDetail]);
    else if (a.choiceField === 'branchPayer') checks.push(['authority', a.fields?.authorityId, a.choiceDetail]);
    else if (a.choiceField === 'licenseId') checks.push(['license', a.licenseId, a.choiceDetail]);
    else checks.push(['branch', a.branchId, a.choiceDetail]);
  }
  if (a.branchDetail) checks.push(['branch', a.branchId, a.branchDetail]);
  for (const [kind, id, want] of checks) {
    if (!id) return 'האפשרות שנבחרה לא זוהתה. בקשו הצעה חדשה.';
    if (kind === 'license') {
      const l = await License.findById(id).select('branchId fileName fileUrl').lean(); const br = l && await Branch.findOne({ _id: l.branchId, adminId }).select('address managerName').lean();
      if (!l || !br) return 'האישור שנבחר לא נמצא. בקשו הצעה חדשה.';
      if (licenseDetail(br, l.fileName) !== want) return 'פרטי האישור שנבחר (כתובת הסניף, מנהל או קובץ) השתנו מאז ההצעה. בקשו הצעה חדשה ובחרו שוב.';
      continue;
    }
    const d = await (kind === 'authority' ? Authority : Branch).findOne({ _id: id, adminId }).select('name address managerName phone type status authorityId').lean();
    if (!d) return 'האפשרות שנבחרה לא נמצאה. בקשו הצעה חדשה.';
    let payer = ''; if (kind === 'branch' && d.authorityId) payer = (await Authority.findOne({ _id: d.authorityId, adminId }).select('name').lean())?.name || '';
    const now = kind === 'authority' ? authorityDetail(d) : branchDetail(d, payer);
    if (now !== want) return 'פרטי האפשרות שנבחרה (כתובת, מנהל, טלפון, סטטוס או גוף משלם) השתנו מאז ההצעה. בקשו הצעה חדשה ובחרו שוב.';
  }
  return null;
};

// Agreement (document destination) candidates: two active agreements can carry the same human branch and payer names
// (different branch ids). Separate them by grounded agreement and branch metadata; refuse when still identical.
const DIR = { incoming: 'אנחנו מקבלים', outgoing: 'אנחנו משלמים' };
const FREQ = { monthly: 'חודשי', quarterly: 'רבעוני', annual: 'שנתי', custom: 'מותאם' };
export const agreementDetail = (ag, br) => [br?.address && String(br.address).trim(), br?.managerName && `מנהל/ת: ${String(br.managerName).trim()}`, DIR[ag.direction], ag.monthlyAmount != null ? `חודשי ${ag.monthlyAmount}` : ag.quarterlyAmount != null ? `רבעוני ${ag.quarterlyAmount}` : ag.annualAmount != null ? `שנתי ${ag.annualAmount}` : '', FREQ[ag.frequency] && `תדירות: ${FREQ[ag.frequency]}`, ag.firstDueDate && `פרעון ראשון: ${new Date(ag.firstDueDate).toISOString().slice(0, 10)}`].filter(Boolean).join(' · ');
export const disambiguateAgreements = (candidates, agreements, branches) => {
  const byAg = new Map(agreements.map((a) => [String(a._id), a])); const groups = new Map();
  for (const c of candidates) { const k = `${normName(c.branchName)}|${normName(c.authorityName)}`; groups.set(k, [...(groups.get(k) || []), c]); }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ds = g.map((c) => { const a = byAg.get(c.id); return a ? agreementDetail(a, branches.get(String(a.branchId))) : ''; });
    if (ds.some((x) => !x) || new Set(ds).size !== ds.length) return `יש כמה הסכמים פעילים של "${g[0].branchName}" מול "${g[0].authorityName}" ואין ביניהם פרט מבדיל במערכת (כתובת, מנהל, סכום, תדירות, פרעון ראשון). שנו שם של סניף או של גוף משלם ואז נסו שוב. המסמך לא נשמר`;
    g.forEach((c, i) => { c.detail = ds[i]; });
  }
  return null;
};
