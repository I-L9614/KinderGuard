// Expiry auto-fill helpers: type-name period parsing and calendar math.
import { describe, it, expect } from 'vitest';
import { parseTypePeriod, addPeriod } from '../frontend/expiryAutofill.js';

describe('parseTypePeriod', () => {
  it('parses a numbered yearly period from anywhere in the name', () => {
    expect(parseTypePeriod('בודק חשמל 5 שנתי')).toEqual({ years: 5 });
    expect(parseTypePeriod('מתקנים תלויים 5 שנתי')).toEqual({ years: 5 });
    expect(parseTypePeriod('קונסטרוקטור -5 שנתי')).toEqual({ years: 5 });
    expect(parseTypePeriod('תקרות תלויות 5 שנתי')).toEqual({ years: 5 });
  });

  it('parses a bare שנתי as one year', () => {
    for (const name of ['כיבוי אש שנתי', 'ווסת מים שנתי', 'רישיון מעון שנתי', 'תברואן שנתי', 'חשמלאי מוסמך שנתי', 'יועץ בטיחות שנתי', 'מתקני חצר שנתי', 'תזונאית שנתי']) {
      expect(parseTypePeriod(name)).toEqual({ years: 1 });
    }
  });

  it('parses חצי שנתי as six months, not one year', () => {
    expect(parseTypePeriod('בדיקת גז חצי שנתי')).toEqual({ months: 6 });
  });

  it('returns null when the name carries no clear period - no guessing', () => {
    expect(parseTypePeriod('אנאל מעונות יום')).toBeNull();
    expect(parseTypePeriod('אישור בטיחות')).toBeNull();
    expect(parseTypePeriod('')).toBeNull();
    expect(parseTypePeriod(null)).toBeNull();
    expect(parseTypePeriod(undefined)).toBeNull();
    expect(parseTypePeriod('בדיקה 0 שנתי')).toBeNull();
  });
});

describe('addPeriod', () => {
  it('adds whole years on the same calendar day', () => {
    expect(addPeriod('2026-11-17', { years: 1 })).toBe('2027-11-17');
    expect(addPeriod('2026-11-17', { years: 5 })).toBe('2031-11-17');
    expect(addPeriod('2026-01-01', { years: 1 })).toBe('2027-01-01');
    expect(addPeriod('2026-12-31', { years: 1 })).toBe('2027-12-31');
  });

  it('adds months on the same calendar day', () => {
    expect(addPeriod('2026-11-17', { months: 6 })).toBe('2027-05-17');
    expect(addPeriod('2026-12-17', { months: 6 })).toBe('2027-06-17');
  });

  it('clamps to the target month last day when the day does not exist there', () => {
    expect(addPeriod('2024-02-29', { years: 1 })).toBe('2025-02-28');
    expect(addPeriod('2024-02-29', { years: 4 })).toBe('2028-02-29');
    expect(addPeriod('2026-08-31', { months: 6 })).toBe('2027-02-28');
    expect(addPeriod('2028-08-31', { months: 6 })).toBe('2029-02-28');
  });

  it('returns empty string on unparseable input or empty period', () => {
    expect(addPeriod('', { years: 1 })).toBe('');
    expect(addPeriod('17/11/2026', { years: 1 })).toBe('');
    expect(addPeriod('2026-11-17', null)).toBe('');
    expect(addPeriod('2026-11-17', {})).toBe('');
  });
});
