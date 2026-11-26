import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { teamRowsFromGrid } from '../src/ai/teamFile.js';
const B = [{ _id: 'b1', name: 'גן שקד' }, { _id: 'b2', name: 'גן ורד' }];
describe('team file intake (local, no model)', () => {
  it('rows become create_user cards; role, branches and emails must be exact; no password anywhere', () => {
    const g = [['שם', 'אימייל', 'תפקיד', 'סניפים'], ['דנה כהן', 'DANA@e.com', 'מנהל סניף', 'גן שקד;גן ורד'], ['משה', 'moshe@e.com', '', ''], ['רות', 'ruth@e.com', 'מנכל', ''], ['אבי', 'avi@e.com', '', 'גן זהב'], ['=x', 'x@e.com', '', ''], ['כפול', 'dana@e.com', '', ''], ['בלי מייל', 'nope', '', ''], ['עדי', 'adi@e.com', 'מנהל חשבון', '']];
    const r = taskless(g); const a = r.actions;
    expect(a.map((x) => x.email)).toEqual(['dana@e.com', 'moshe@e.com', 'adi@e.com']);
    expect(a[0]).toMatchObject({ type: 'create_user', sensitive: true, suggestedRole: 'Manager', branchIds: ['b1', 'b2'] }); expect(a[2].suggestedRole).toBe('Admin'); expect(JSON.stringify(a)).not.toMatch(/password|סיסמה/i);
    const t = r.rejected.join('|'); expect(t).toMatch(/שורה 4: התפקיד "מנכל"/); expect(t).toMatch(/שורה 5: הסניף "גן זהב"/); expect(t).toMatch(/שורה 6: ערך שמתחיל בתו חשוד.*שם/); expect(t).toMatch(/שורה 7: האימייל dana@e.com/); expect(t).toMatch(/שורה 8: חסר שם או אימייל תקין/);
  });
  it('needs name and email columns', () => { expect(teamRowsFromGrid([['שם'], ['x']], B).rejected.join(' ')).toMatch(/חסרות עמודות/); });
});
const taskless = (g) => teamRowsFromGrid(g, B);
