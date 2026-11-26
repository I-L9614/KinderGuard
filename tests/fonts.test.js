import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const root = path.resolve(__dirname, '../frontend');
describe('bundled Assistant font', () => {
  it('theme-c loads Assistant from local files, no remote fonts', () => {
    const css = fs.readFileSync(path.join(root, 'theme-c.css'), 'utf8');
    const urls = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(8);
    for (const u of urls) expect(fs.existsSync(path.join(root, u))).toBe(true);
    expect(/https?:\/\/[^)]*font/i.test(css)).toBe(false);
    expect(fs.existsSync(path.join(root, 'fonts/OFL.txt'))).toBe(true);
  });
});
