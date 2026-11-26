import { describe, it, expect, vi } from 'vitest';
import { canUseAi, requireAiAccess } from '../src/ai/aiAccess.js';
import { createClaudeClient, costUsd, worstCaseUsd } from '../src/ai/claudeClient.js';

// Routes by URL: count_tokens returns the given count, messages returns a reply.
const okFetch = ({ count = 1000, messages } = {}) => vi.fn(async (url) => String(url).endsWith('/count_tokens')
  ? { ok: true, json: async () => ({ input_tokens: count }) }
  : messages || { ok: true, json: async () => ({ content: [{ type: 'thinking', thinking: '..' }, { type: 'text', text: 'שלום' }], usage: { input_tokens: 1000, output_tokens: 200 }, stop_reason: 'end_turn' }) });
const generated = (f) => f.mock.calls.filter((c) => String(c[0]).endsWith('/v1/messages'));

describe('AI access', () => {
  it('allows only users with aiEnabled, including co-admins without it', () => {
    expect(canUseAi({ role: 'Admin', aiEnabled: true })).toBe(true);
    expect(canUseAi({ role: 'Manager', aiEnabled: true })).toBe(true);
    expect(canUseAi({ role: 'Admin' })).toBe(false);
    expect(canUseAi({ role: 'Manager' })).toBe(false);
    expect(canUseAi(null)).toBe(false);
  });
  it('middleware returns 403 for a user without access', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    requireAiAccess({ user: { role: 'Manager' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Claude client guards', () => {
  it('prices the short tier at 0.10/0.50 and the long tier above 100K at 0.50/2.50', () => {
    expect(costUsd({ input_tokens: 1e6 - 1, output_tokens: 0 })).toBeGreaterThan(0.4); // over 100K prompt: long tier
    expect(costUsd({ input_tokens: 100000, output_tokens: 1e6 })).toBeCloseTo(0.01 + 0.5);
    expect(worstCaseUsd(1000, 4000)).toBeCloseTo((1000 * 0.5 + 4000 * 2.5) / 1e6);
  });
  it('refuses without key and never calls the network', async () => {
    const f = okFetch();
    await expect(createClaudeClient({ apiKey: '', fetchImpl: f }).ask({ prompt: 'x' })).rejects.toThrow(/not configured/);
    expect(f).not.toHaveBeenCalled();
  });
  it('counts first with the same model and payload, then generates with the documented fields', async () => {
    const f = okFetch();
    const c = createClaudeClient({ apiKey: 'k-test', fetchImpl: f });
    const r = await c.ask({ system: 'sys', prompt: 'x' });
    expect(r.text).toBe('שלום'); // thinking block skipped
    expect(String(f.mock.calls[0][0])).toContain('/count_tokens');
    const countBody = JSON.parse(f.mock.calls[0][1].body); const genBody = JSON.parse(generated(f)[0][1].body);
    expect(countBody).toEqual({ model: 'claude-haiku-5-5', system: 'sys', messages: genBody.messages });
    expect(generated(f)[0][1].headers['anthropic-version']).toBe('2026-10-21');
    expect(generated(f)[0][1].headers['x-api-key']).toBe('k-test');
    expect(generated(f)[0][1].body).not.toContain('k-test');
    expect(genBody.output_config).toEqual({ effort: 'low' }); expect(genBody).not.toHaveProperty('temperature'); expect(genBody.max_tokens).toBe(4000);
    expect(await c.ledger.spent()).toBeCloseTo(costUsd({ input_tokens: 1000, output_tokens: 200 }));
  });
  it('fails closed when counting fails: no generation, no spend', async () => {
    const f = vi.fn(async (url) => (String(url).endsWith('/count_tokens') ? { ok: false, status: 500 } : { ok: true, json: async () => ({}) }));
    const c = createClaudeClient({ apiKey: 'k', fetchImpl: f });
    await expect(c.ask({ prompt: 'x' })).rejects.toThrow(/verify/);
    expect(generated(f).length).toBe(0); expect(await c.ledger.spent()).toBe(0);
    const bad = vi.fn(async () => ({ ok: true, json: async () => ({ input_tokens: 'many' }) }));
    await expect(createClaudeClient({ apiKey: 'k', fetchImpl: bad }).ask({ prompt: 'x' })).rejects.toThrow(/verify/);
  });
  it('rejects inputs near the 100K tier boundary (over 90K counted) before generating', async () => {
    const f = okFetch({ count: 90001 });
    await expect(createClaudeClient({ apiKey: 'k', fetchImpl: f }).ask({ prompt: 'x' })).rejects.toThrow(/too large/);
    expect(generated(f).length).toBe(0);
  });
  it('a failed generation keeps its reservation, and the daily limit counts it', async () => {
    const f = okFetch({ messages: { ok: false, status: 500 } });
    const c = createClaudeClient({ apiKey: 'k', fetchImpl: f, dailyCallLimit: 2 });
    await expect(c.ask({ prompt: 'x' })).rejects.toThrow(/failed/);
    await expect(c.ask({ prompt: 'x' })).rejects.toThrow(/failed/);
    await expect(c.ask({ prompt: 'x' })).rejects.toThrow(/limit/);
    expect(generated(f).length).toBe(2);
    expect(await c.ledger.spent()).toBeCloseTo(2 * worstCaseUsd(1000, 4000));
  });
  it('stops when the worst case no longer fits the budget', async () => {
    const f = okFetch();
    const c = createClaudeClient({ apiKey: 'k', fetchImpl: f, budgetUsd: worstCaseUsd(1000, 4000) * 1.5 });
    await c.ask({ prompt: 'x' }); // settles to a much smaller real cost
    await c.ask({ prompt: 'x' });
    await c.ask({ prompt: 'x' }); // real costs are tiny, still fits
    const tight = createClaudeClient({ apiKey: 'k', fetchImpl: okFetch(), budgetUsd: worstCaseUsd(1000, 4000) / 2 });
    await expect(tight.ask({ prompt: 'x' })).rejects.toThrow(/budget/);
  });
  it('flags a reply cut off at max_tokens', async () => {
    const f = okFetch({ messages: { ok: true, json: async () => ({ content: [{ type: 'text', text: 'חצי' }], usage: { input_tokens: 10, output_tokens: 4000 }, stop_reason: 'max_tokens' }) } });
    expect((await createClaudeClient({ apiKey: 'k', fetchImpl: f }).ask({ prompt: 'x' })).truncated).toBe(true);
  });
  it('double settle cannot credit the budget twice', async () => {
    const c = createClaudeClient({ apiKey: 'k', fetchImpl: okFetch() });
    const r = await c.ledger.reserve(1);
    expect(await c.ledger.settle(r, 0.1)).toBe(true);
    expect(await c.ledger.settle(r, 0.1)).toBe(false);
    expect(await c.ledger.spent()).toBeCloseTo(0.1);
  });
  it('invalid usage fails closed, keeps the reservation and does not log the key', async () => {
    const logs = [];
    const f = okFetch({ messages: { ok: true, json: async () => ({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 'a' } }) } });
    const c = createClaudeClient({ apiKey: 'k-secret', fetchImpl: f, log: (...a) => logs.push(JSON.stringify(a)) });
    await expect(c.ask({ prompt: 'x' })).rejects.toThrow(/verified/);
    expect(await c.ledger.spent()).toBeCloseTo(worstCaseUsd(1000, 4000));
    expect(logs.length).toBe(1); expect(logs[0]).not.toContain('k-secret');
  });
  it('passes an abort signal (timeout) and a network error counts against the ledger', async () => {
    const f = vi.fn(async (url, o) => { if (String(url).endsWith('/count_tokens')) return { ok: true, json: async () => ({ input_tokens: 10 }) }; expect(o.signal).toBeDefined(); throw new Error('aborted'); });
    const c = createClaudeClient({ apiKey: 'k', fetchImpl: f });
    await expect(c.ask({ prompt: 'x' })).rejects.toThrow(/failed/);
    expect(await c.ledger.spent()).toBeGreaterThan(0);
  });
  it('never retries on its own: one count and one generation per ask', async () => {
    const f = okFetch({ messages: { ok: false, status: 529 } });
    await expect(createClaudeClient({ apiKey: 'k', fetchImpl: f }).ask({ prompt: 'x' })).rejects.toThrow(/failed/);
    expect(f.mock.calls.length).toBe(2);
  });
  it('reserves the worst case for the actual per-call output cap (not a fixed constant) and sends that same cap', async () => {
    for (const cap of [200, 1500, 3500]) {
      const f = okFetch({ count: 1234 }); const reserve = vi.fn(async (est) => ({ reservationId: 'r', estUsd: est })); const settle = vi.fn(async () => true);
      await createClaudeClient({ apiKey: 'k', fetchImpl: f, ledger: { reserve, settle } }).ask({ prompt: 'x', maxOutput: cap });
      expect(reserve).toHaveBeenCalledTimes(1); expect(reserve.mock.calls[0][0]).toBeCloseTo(worstCaseUsd(1234, cap));
      expect(JSON.parse(generated(f)[0][1].body).max_tokens).toBe(cap);
    }
    expect(worstCaseUsd(1234, 3500)).toBeGreaterThan(worstCaseUsd(1234, 1500));
  });
  it('a 3500-token call is refused before generation when the remaining budget cannot cover its own worst case', async () => {
    const need = worstCaseUsd(1000, 3500);
    const f = okFetch({ count: 1000 }); const reserve = vi.fn(async (est) => { if (est > need - 1e-9 && est > need * 0.99) throw Object.assign(new Error('AI budget reached'), { statusCode: 429 }); return { reservationId: 'r', estUsd: est }; });
    await expect(createClaudeClient({ apiKey: 'k', fetchImpl: f, ledger: { reserve, settle: vi.fn() } }).ask({ prompt: 'x', maxOutput: 3500 })).rejects.toMatchObject({ statusCode: 429 });
    expect(generated(f)).toHaveLength(0);
    const real = createClaudeClient({ apiKey: 'k', fetchImpl: okFetch({ count: 1000 }), budgetUsd: worstCaseUsd(1000, 1500) + 1e-6, dailyCallLimit: 5 });
    await expect(real.ask({ prompt: 'x', maxOutput: 3500 })).rejects.toMatchObject({ statusCode: 429 });
    await expect(real.ask({ prompt: 'x', maxOutput: 1500 })).resolves.toBeTruthy();
  });
});
