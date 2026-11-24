// Israel-time day logic: server runs on UTC, business day is Asia/Jerusalem.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { israelToday, calendarDay, daysUntil, israelParts, israelMidnightInstant, israelEndOfDayInstant } from '../src/utils/israelTime.js';
import { popupWindowOpen } from '../frontend/nativeNotify.js';
import { statusForExpiry } from '../src/controllers/licenseController.js';

const iso = (d) => d.toISOString();
afterEach(() => vi.useRealTimers());

describe('israelToday', () => {
  it('is already the next day just after Israel midnight, while UTC is still the previous day (winter, UTC+2)', () => {
    expect(iso(israelToday(new Date('2026-11-24T22:30:00Z')))).toBe('2026-11-25T00:00:00.000Z'); // 00:30 Israel
    expect(iso(israelToday(new Date('2026-11-24T21:59:00Z')))).toBe('2026-11-24T00:00:00.000Z'); // 23:59 Israel
  });
  it('uses UTC+3 in summer time', () => {
    expect(iso(israelToday(new Date('2026-07-14T21:30:00Z')))).toBe('2026-07-15T00:00:00.000Z'); // 00:30 Israel
    expect(iso(israelToday(new Date('2026-07-14T20:59:00Z')))).toBe('2026-07-14T00:00:00.000Z');
  });
  it('handles both DST switch days (2026-03-27 spring forward, 2026-10-25 fall back)', () => {
    expect(iso(israelToday(new Date('2026-03-26T22:30:00Z')))).toBe('2026-03-27T00:00:00.000Z'); // 00:30 IST (+2)
    expect(iso(israelToday(new Date('2026-03-27T21:30:00Z')))).toBe('2026-03-28T00:00:00.000Z'); // 00:30 IDT (+3)
    expect(iso(israelToday(new Date('2026-10-24T21:30:00Z')))).toBe('2026-10-25T00:00:00.000Z'); // 00:30 IDT
    expect(iso(israelToday(new Date('2026-10-25T22:30:00Z')))).toBe('2026-10-26T00:00:00.000Z'); // 00:30 IST (+2... after fall back)
  });
});

describe('daysUntil / license status', () => {
  it('counts whole calendar days from the Israel date', () => {
    const now = new Date('2026-11-24T22:30:00Z'); // Nov 25 00:30 Israel
    expect(daysUntil('2026-11-25', now)).toBe(0);
    expect(daysUntil('2026-11-24', now)).toBe(-1);
    expect(daysUntil('2026-12-25', now)).toBe(30);
    expect(daysUntil(new Date('2026-12-02T00:00:00Z'), now)).toBe(7);
  });
  it('flips a license to Expired at Israel midnight, not at UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T21:59:00Z')); // 23:59 Israel, Nov 24
    expect(statusForExpiry('2026-11-24')).toBe('Expiring_Soon');
    vi.setSystemTime(new Date('2026-11-24T22:01:00Z')); // 00:01 Israel, Nov 25
    expect(statusForExpiry('2026-11-24')).toBe('Expired');
    expect(statusForExpiry('2026-12-25')).toBe('Expiring_Soon'); // 30 days
    expect(statusForExpiry('2026-12-26')).toBe('Valid');
  });
  it('a 09:00 UTC-style server hour still gives the right Israel day', () => {
    expect(daysUntil('2026-11-24', new Date('2026-11-24T08:00:00Z'))).toBe(0);
  });
});

describe('day boundaries as real instants', () => {
  it('midnight Israel is 22:00Z in winter and 21:00Z in summer', () => {
    expect(iso(israelMidnightInstant('2026-11-25'))).toBe('2026-11-24T22:00:00.000Z');
    expect(iso(israelMidnightInstant('2026-07-15'))).toBe('2026-07-14T21:00:00.000Z');
    expect(iso(israelMidnightInstant('2026-03-27'))).toBe('2026-03-26T22:00:00.000Z');
    expect(iso(israelMidnightInstant('2026-10-25'))).toBe('2026-10-24T21:00:00.000Z');
  });
  it('end of day is the last millisecond before the next Israel midnight', () => {
    expect(iso(israelEndOfDayInstant('2026-11-24'))).toBe('2026-11-24T21:59:59.999Z');
    expect(iso(israelEndOfDayInstant('2026-10-25'))).toBe('2026-10-25T21:59:59.999Z'); // 25h day
  });
  it('calendarDay keeps stored date-only values on their own date', () => {
    expect(iso(calendarDay('2026-11-24'))).toBe('2026-11-24T00:00:00.000Z');
    expect(iso(calendarDay(new Date('2026-11-24T23:59:59Z')))).toBe('2026-11-24T00:00:00.000Z');
  });
});

describe('11:00 Israel popup window', () => {
  it('opens at 11:00 Israel in winter and summer', () => {
    expect(popupWindowOpen(new Date('2026-11-24T08:59:00Z'))).toBe(false); // 10:59
    expect(popupWindowOpen(new Date('2026-11-24T09:00:00Z'))).toBe(true);  // 11:00
    expect(popupWindowOpen(new Date('2026-07-14T07:59:00Z'))).toBe(false); // 10:59
    expect(popupWindowOpen(new Date('2026-07-14T08:00:00Z'))).toBe(true);  // 11:00
    expect(popupWindowOpen(new Date('2026-11-24T22:30:00Z'))).toBe(false); // 00:30 next day
    expect(popupWindowOpen(new Date('2026-11-24T20:00:00Z'))).toBe(true);  // 22:00 (late launch still catches up)
  });
  it('parts are read from Israel, whatever the machine timezone', () => {
    expect(israelParts(new Date('2026-11-24T09:00:00Z'))).toMatchObject({ day: 24, hour: 11 });
  });
});

describe('frontend copy', () => {
  it('stays identical to the server module', () => {
    expect(fs.readFileSync('frontend/israelTime.js', 'utf8')).toBe(fs.readFileSync('src/utils/israelTime.js', 'utf8'));
  });
});
