import { describe, it, expect } from 'vitest';
import { visibleCount, collapseLabel, LIST_LIMITS } from '../frontend/collapsibleList.js';
describe('collapsible lists', () => {
  it('shows everything when the list fits', () => {
    expect(visibleCount(7, 7, false, false)).toBe(7);
    expect(visibleCount(10, 10, false, false)).toBe(10);
  });
  it('cuts long lists to the limit until expanded', () => {
    expect(visibleCount(25, LIST_LIMITS.card, false, false)).toBe(7);
    expect(visibleCount(25, LIST_LIMITS.row, false, false)).toBe(10);
    expect(visibleCount(25, LIST_LIMITS.card, true, false)).toBe(25);
  });
  it('shows every match while searching, including previously hidden items', () => {
    expect(visibleCount(25, 7, false, true)).toBe(25);
  });
  it('labels show-all with the remaining count and show-less when open', () => {
    expect(collapseLabel(18, false)).toBe('הצג הכול (עוד 18)');
    expect(collapseLabel(18, true)).toBe('הצג פחות');
  });
  it('limits stay within 7 to 10', () => {
    expect(LIST_LIMITS.card).toBeGreaterThanOrEqual(7);
    expect(LIST_LIMITS.row).toBeLessThanOrEqual(10);
  });
});
