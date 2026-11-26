export const normName = (s) => String(s || '').normalize('NFKC').replace(/[\s\u200e\u200f"'׳״.\-_,]+/g, ' ').trim().toLowerCase();
