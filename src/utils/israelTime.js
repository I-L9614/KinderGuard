// Israel calendar-day helpers. The server runs on UTC (Render) while the
// business day is Asia/Jerusalem (UTC+2 winter, UTC+3 summer), so "today"
// must never come from the server's local clock.
//
// Convention: a calendar day is represented by the UTC midnight of that date,
// which is exactly how date-only form values ("2026-11-24") are stored.
// frontend/israelTime.js carries the same logic for the browser/desktop app.
export const ISRAEL_TZ = 'Asia/Jerusalem';
export const DAY_MS = 86400000;

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ISRAEL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const israelParts = (now = new Date()) => {
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
};

// Today's Israel calendar date, as a UTC-midnight Date.
export const israelToday = (now = new Date()) => {
  const { year, month, day } = israelParts(now);
  return new Date(Date.UTC(year, month - 1, day));
};

// The calendar date a stored/date-only value stands for (its UTC date).
export const calendarDay = (value) => {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export const daysUntil = (value, now = new Date()) => Math.round((calendarDay(value) - israelToday(now)) / DAY_MS);

// Real instant of 00:00 Israel time on the given calendar date (DST-safe).
export const israelMidnightInstant = (value) => {
  const day = calendarDay(value);
  for (const offsetH of [3, 2]) {
    const t = new Date(day.getTime() - offsetH * 3600000);
    const p = israelParts(t);
    if (p.hour === 0 && p.minute === 0 && p.day === day.getUTCDate()) return t;
  }
  return new Date(day.getTime() - 2 * 3600000);
};
// Last millisecond of that Israel calendar day.
export const israelEndOfDayInstant = (value) => new Date(israelMidnightInstant(new Date(calendarDay(value).getTime() + DAY_MS)).getTime() - 1);
