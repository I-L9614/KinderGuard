import { describe, it, expect, vi } from 'vitest';
import { createClaudeClient, AI_MSG } from '../src/ai/claudeClient.js';

const json = (status, body) => ({ ok: status < 300, status, json: async () => body, clone() { return this; } });
const creditBody = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };

describe('provider credit exhaustion shows a safe Hebrew message', () => {
  it('on messages call', async () => {
    const f = vi.fn(async (url) => String(url).endsWith('/count_tokens') ? json(200, { input_tokens: 100 }) : json(400, creditBody));
    const err = await createClaudeClient({ apiKey: 'k', fetchImpl: f }).ask({ prompt: 'x' }).catch((e) => e);
    expect(err.statusCode).toBe(503); expect(err.message).toBe(AI_MSG.credit);
    expect(err.message).not.toMatch(/credit balance|Anthropic|billing|http/i);
  });
  it('on count_tokens call (no generation attempted)', async () => {
    const f = vi.fn(async () => json(400, creditBody));
    const err = await createClaudeClient({ apiKey: 'k', fetchImpl: f }).ask({ prompt: 'x' }).catch((e) => e);
    expect(err.statusCode).toBe(503); expect(err.message).toBe(AI_MSG.credit); expect(f).toHaveBeenCalledTimes(1);
  });
  it('rejected key is a safe unavailable message, other failures stay generic 502', async () => {
    const mk = (st, body) => vi.fn(async (url) => String(url).endsWith('/count_tokens') ? json(200, { input_tokens: 100 }) : json(st, body));
    const a = await createClaudeClient({ apiKey: 'k', fetchImpl: mk(401, { error: { message: 'invalid x-api-key' } }) }).ask({ prompt: 'x' }).catch((e) => e);
    expect(a.statusCode).toBe(503); expect(a.message).toBe(AI_MSG.notConfigured);
    const b = await createClaudeClient({ apiKey: 'k', fetchImpl: mk(500, {}) }).ask({ prompt: 'x' }).catch((e) => e);
    expect(b.statusCode).toBe(502);
  });
  it('internal budget and daily limit messages are Hebrew', async () => {
    const f = vi.fn(async (url) => json(200, { input_tokens: 100 }));
    const c = createClaudeClient({ apiKey: 'k', fetchImpl: f, budgetUsd: 0.0000001, dailyCallLimit: 5 });
    const e1 = await c.ask({ prompt: 'x' }).catch((e) => e); expect(e1.message).toBe(AI_MSG.budget);
    const c2 = createClaudeClient({ apiKey: 'k', fetchImpl: f, budgetUsd: 5, dailyCallLimit: 1, ledger: undefined });
    await c2.ledger.reserve(0.0001); const e2 = await c2.ask({ prompt: 'x' }).catch((e) => e); expect(e2.message).toBe(AI_MSG.daily);
  });
});
