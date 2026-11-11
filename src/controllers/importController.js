import Authority from '../models/Authority.js';
import Branch from '../models/Branch.js';
import { getAdminId } from '../utils/access.js';

// Bulk import of payers (councils and private landlords) with their branches,
// from the landlord spreadsheet the owner supplies. Idempotent and
// non-destructive: existing payers are matched by exact name, existing
// branches are matched by exact name and only have EMPTY fields filled -
// nothing the user already entered is ever overwritten. Payment amounts are
// deliberately not part of this import; rent agreements come later.
export const importPayersBranches = async (req, res) => {
  const adminId = getAdminId(req.user);
  const authoritiesIn = Array.isArray(req.body.authorities) ? req.body.authorities : [];
  const branchesIn = Array.isArray(req.body.branches) ? req.body.branches : [];
  if (!authoritiesIn.length && !branchesIn.length) {
    return res.status(400).json({ message: 'לא נשלחו גופי תשלום או סניפים לייבוא' });
  }

  const summary = { authorities: { created: [], existing: [] }, branches: { created: [], updated: [], skipped: [] } };

  const byName = {};
  for (const item of authoritiesIn) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const type = item.type === 'private' ? 'private' : 'council';
    let authority = await Authority.findOne({ adminId, name });
    if (authority) {
      summary.authorities.existing.push(name);
    } else {
      authority = await Authority.create({ adminId, name, type });
      summary.authorities.created.push(name);
    }
    byName[name] = authority;
  }

  for (const item of branchesIn) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const address = String(item.address || '').trim();
    const managerName = String(item.managerName || '').trim();
    const phone = String(item.phone || '').trim();
    const emails = (Array.isArray(item.emails) ? item.emails : []).map((e) => String(e).trim()).filter(Boolean);
    const authorityName = String(item.authorityName || '').trim();
    let authorityId = null;
    if (authorityName) {
      if (!byName[authorityName]) {
        // Referenced payer missing from the authorities list: create it as a
        // council (the common case) rather than dropping the association.
        byName[authorityName] = await Authority.findOne({ adminId, name: authorityName })
          || await Authority.create({ adminId, name: authorityName, type: 'council' });
      }
      authorityId = byName[authorityName]._id;
    }

    const existing = await Branch.findOne({ adminId, name });
    if (!existing) {
      await Branch.create({ adminId, name, address, managerName, phone, emails, authorityId });
      summary.branches.created.push(name);
      continue;
    }

    // Existing branch: fill only empty fields, never overwrite user data.
    const set = {};
    if (!existing.address && address) set.address = address;
    if (!existing.managerName && managerName) set.managerName = managerName;
    if (!existing.phone && phone) set.phone = phone;
    if ((!existing.emails || existing.emails.length === 0) && emails.length) set.emails = emails;
    if (!existing.authorityId && authorityId) set.authorityId = authorityId;
    if (Object.keys(set).length) {
      await Branch.updateOne({ _id: existing._id }, { $set: set });
      summary.branches.updated.push(name);
    } else {
      summary.branches.skipped.push(name);
    }
  }

  res.json(summary);
};
