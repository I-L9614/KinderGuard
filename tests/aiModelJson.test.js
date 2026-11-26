import { describe, it, expect } from 'vitest';
import { parseModelJson } from '../src/ai/modelJson.js';

const acceptRows = { accept: (x) => Array.isArray(x.rows) };
describe('parseModelJson: one well-formed expected object, never a guess between conflicting ones', () => {
  it('plain, fenced, and prose before or after the object', () => {
    for (const t of ['{"rows":[{"a":1}]}', '```json\n{"rows":[{"a":1}]}\n```', '```json\n{"rows":[{"a":1}]}\n```\n\nהטבלה מכילה 22 שורות והוחזרו 21.', 'הנה התשובה: {"rows":[{"a":1}]} סוף']) {
      const r = parseModelJson(t, acceptRows); expect(r.status).toBe('ok'); expect(r.value.rows).toEqual([{ a: 1 }]);
    }
  });
  it('braces inside strings and stray braces in prose do not break it', () => {
    const r = parseModelJson('הערה } אחרת { \n{"rows":[{"a":"x } y { z"}]}\nסיום {', acceptRows);
    expect(r.status).toBe('ok'); expect(r.value.rows[0].a).toBe('x } y { z');
  });
  it('two different expected objects are a conflict and return nothing', () => {
    const r = parseModelJson('{"rows":[{"a":1}]} ושוב {"rows":[{"a":2}]}', acceptRows); expect(r).toEqual({ status: 'conflict', value: null });
  });
  it('the same object twice is accepted once', () => {
    expect(parseModelJson('{"rows":[1]}\n```\n{"rows":[1]}\n```', acceptRows).status).toBe('ok');
  });
  it('objects that fail the schema are ignored, not mistaken for the answer', () => {
    expect(parseModelJson('{"note":"x"}', acceptRows).status).toBe('none');
    expect(parseModelJson('{"note":"x"} {"rows":[]}', acceptRows).status).toBe('ok');
  });
  it('arrays, truncated JSON, empty and non-text input give none', () => {
    for (const t of ['[{"rows":[]}]', '{"rows":[{"a":1}', '', null, undefined, 'אין כאן JSON']) expect(parseModelJson(t, acceptRows).status).toBe('none');
  });
});
