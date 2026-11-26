import { describe, it, expect } from 'vitest';
import { taskRowsFromGrid } from '../src/ai/taskFile.js';

const B = [{ _id: 'b1', name: 'גן שקד' }, { _id: 'b2', name: 'גן ורד' }, { _id: 'b3', name: 'גן ורד ' }];
describe('task file intake (local, no model)', () => {
  it('turns rows into create_task actions, resolving branches exactly and refusing the rest by row', () => {
    const g = [['כותרת', 'הערות', 'תאריך יעד', 'סניף'], ['לחדש אישור', 'דחוף', '2026-12-31', 'גן שקד'], ['בלי סניף', '', '', ''], ['=HYPERLINK("x")', '', '', ''], ['סניף לא קיים', '', '', 'גן זהב'], ['תאריך שגוי', '', '31/12/2026', ''], ['', 'x', '', ''], ['סניף כפול', '', '', 'גן ורד']];
    const r = taskRowsFromGrid(g, B);
    expect(r.actions.map((a) => a.title)).toEqual(['לחדש אישור', 'בלי סניף']);
    expect(r.actions[0]).toMatchObject({ type: 'create_task', branchId: 'b1', dueDate: '2026-12-31', notes: 'דחוף' });
    const t = r.rejected.join('|'); expect(t).toMatch(/שורה 4: ערך שמתחיל בתו חשוד/); expect(t).toMatch(/שורה 5: הסניף "גן זהב" לא נמצא/); expect(t).toMatch(/שורה 6: תאריך/); expect(t).toMatch(/שורה 7: חסרה כותרת/); expect(t).toMatch(/שורה 8: הסניף "גן ורד" לא חד/);
  });
  it('a calendar-invalid date (2026-02-30, 2026-13-01) refuses the row and is reported, never dropped silently', () => {
    const r = taskRowsFromGrid([['כותרת', 'תאריך יעד'], ['א', '2026-02-30'], ['ב', '2026-13-01'], ['ג', '2028-02-29']], B);
    expect(r.actions.map((a) => a.title)).toEqual(['ג']); expect(r.actions[0].dueDate).toBe('2028-02-29'); expect(r.rejected.join('|')).toMatch(/שורה 2: תאריך "2026-02-30".*שורה 3: תאריך "2026-13-01"/);
  });
  it('needs a title column and data rows; caps at 20 rows and says so', () => {
    expect(taskRowsFromGrid([['הערות'], ['x']], B).rejected.join(' ')).toMatch(/עמודת כותרת/);
    expect(taskRowsFromGrid([['כותרת']], B).rejected.join(' ')).toMatch(/ריק/);
    const big = [['כותרת'], ...Array.from({ length: 30 }, (_, i) => [`מ${i}`])]; const r = taskRowsFromGrid(big, B);
    expect(r.rejected.join(' ')).toMatch(/נקראו 20 הראשונות/); expect(r.actions).toHaveLength(20);
  });
});
