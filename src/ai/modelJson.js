// Defensive JSON extraction from a model answer. The model may wrap the JSON in a code fence or add a sentence before or after it.
// Exactly one well-formed object that passes `accept` is returned. Several DIFFERENT accepted objects are a conflict and are never
// merged or guessed between. No accepted object is 'none'. The server still validates every row after this.
const MAX_SCAN = 200000;
const objectAt = (s, start) => {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth += 1; else if (c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
};
export const parseModelJson = (text, { accept = () => true } = {}) => {
  const s = String(text ?? '').slice(0, MAX_SCAN);
  const found = new Map();
  let pos = 0;
  while (pos < s.length) {
    const start = s.indexOf('{', pos);
    if (start < 0) break;
    // A '{' that is a member of an array or an outer value (preceded by [ or ,) is not a top-level answer.
    if (/[[,]\s*$/.test(s.slice(Math.max(0, start - 50), start))) { pos = start + 1; continue; }
    const end = objectAt(s, start);
    if (end < 0) { pos = start + 1; continue; }
    let o; try { o = JSON.parse(s.slice(start, end + 1)); } catch { o = undefined; }
    if (o && typeof o === 'object' && !Array.isArray(o) && accept(o)) { found.set(JSON.stringify(o), o); pos = end + 1; } else pos = start + 1;
  }
  if (found.size === 0) return { status: 'none', value: null };
  if (found.size > 1) return { status: 'conflict', value: null };
  return { status: 'ok', value: [...found.values()][0] };
};
