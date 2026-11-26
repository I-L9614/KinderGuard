import { describe, it, expect } from 'vitest';
import { computeCompleteness } from '../frontend/completeness.js';
const types = [{ _id: 't1' }, { _id: 't2' }, { _id: 't3' }];
const lic = (t, status) => ({ licenseTypeId: t, status });
describe('branch completeness', () => {
  it('does not count an expired approval as present', () => {
    const c = computeCompleteness(types, [lic('t1', 'Valid'), lic('t2', 'Expired'), lic('t3', 'Valid')]);
    expect(c).toMatchObject({ total: 3, present: 2, expired: 1, missing: 0 });
  });
  it('counts expiring-soon as present but separate from valid', () => {
    const c = computeCompleteness(types, [lic('t1', 'Valid'), lic('t2', 'Expiring_Soon'), lic('t3', 'Valid')]);
    expect(c).toMatchObject({ present: 3, valid: 2, expiring: 1, expired: 0 });
  });
  it('separates missing from expired and accepts populated type ids', () => {
    const c = computeCompleteness(types, [{ licenseTypeId: { _id: 't1' }, status: 'Expired' }]);
    expect(c).toMatchObject({ present: 0, expired: 1, missing: 2 });
  });
  it('a newer valid row wins over an older expired one', () => {
    expect(computeCompleteness(types, [lic('t1', 'Expired'), lic('t1', 'Valid')]).present).toBe(1);
  });
});

import { expiryAllClear } from '../frontend/completeness.js';
describe('branch card all-clear line', () => {
  const full = { total: 3, missing: 0, expired: 0 };
  it('is green only when nothing is missing or expired', () => {
    expect(expiryAllClear({ expiredCount: 0, expiring: 0, completeness: full })).toBe('good');
  });
  it('is never green while approvals are missing', () => {
    expect(expiryAllClear({ expiredCount: 0, expiring: 0, completeness: { total: 12, missing: 12, expired: 0 } })).toBe('neutral');
  });
  it('is never green when a required approval is expired, and a branch with no required types is neutral', () => {
    expect(expiryAllClear({ expiredCount: 0, expiring: 0, completeness: { total: 3, missing: 0, expired: 1 } })).toBe('neutral');
    expect(expiryAllClear({ expiredCount: 0, expiring: 0, completeness: { total: 0, missing: 0, expired: 0 } })).toBe('neutral');
  });
  it('leaves the expired and expiring lines to their own signals', () => {
    expect(expiryAllClear({ expiredCount: 1, expiring: 0, completeness: full })).toBeNull();
    expect(expiryAllClear({ expiredCount: 0, expiring: 2, completeness: full })).toBeNull();
  });
});
