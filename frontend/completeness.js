// Completeness of a branch = required approval types that have a valid
// approval on file. Expiring-soon still counts as present; an expired
// approval counts as needing action, never as present. Stored data is not read
// or changed here.
const idOf = (v) => String(v?._id || v);
export function computeCompleteness(types, licenses) {
  const out = { total: types.length, present: 0, valid: 0, expiring: 0, expired: 0, missing: 0 };
  types.forEach((type) => {
    const rows = licenses.filter((l) => idOf(l.licenseTypeId) === String(type._id));
    if (!rows.length) { out.missing += 1; return; }
    const live = rows.find((l) => l.status !== 'Expired');
    const row = live || rows[0];
    if (!live) out.expired += 1;
    else { out.present += 1; if (row.status === 'Expiring_Soon') out.expiring += 1; else out.valid += 1; }
  });
  return out;
}
