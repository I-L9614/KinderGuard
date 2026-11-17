// Expiry auto-fill for the license form: the validity period is encoded in
// the license-type name (e.g. "בודק חשמל 5 שנתי" = five years, "כיבוי אש
// שנתי" = one year). Only unambiguous names are parsed - anything else
// returns null and the field stays manual. No guessing.

export const parseTypePeriod = (name) => {
  const text = String(name || '').trim();
  if (!text) return null;
  // "חצי שנתי" must be checked before the bare "שנתי" (it contains it).
  if (/חצי\s*שנתי/.test(text)) return { months: 6 };
  const numbered = text.match(/(\d+)\s*שנתי/);
  if (numbered) {
    const years = Number(numbered[1]);
    return years > 0 ? { years } : null;
  }
  if (/שנתי/.test(text)) return { years: 1 };
  return null;
};

// Adds a period to an ISO yyyy-mm-dd date string, returning ISO yyyy-mm-dd.
// Same calendar day in the target month/year; clamps to the target month's
// last day when the day does not exist there (29.2.2024 + 1y -> 28.2.2025,
// 31.8.2026 + 6m -> 28.2.2027). Returns '' on unparseable input.
export const addPeriod = (isoDate, period) => {
  if (!period) return '';
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const [year, month, day] = match.slice(1).map(Number);
  const totalMonths = (period.years || 0) * 12 + (period.months || 0);
  if (!totalMonths) return '';
  const monthIndex = (month - 1) + totalMonths;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const lastDay = new Date(targetYear, targetMonth, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
};
