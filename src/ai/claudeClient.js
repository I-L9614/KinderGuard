// Thin Claude client with hard cost guards. The API key comes only from the
// environment (ANTHROPIC_API_KEY) and is never logged or returned.
export const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
// USD per million tokens (platform.claude.com pricing): prompts up to 100K
// tokens use the first tier, longer prompts the second.
const PRICE = { short: { inputPerM: 0.10, outputPerM: 0.50 }, long: { inputPerM: 0.50, outputPerM: 2.50 } };
const LONG_PROMPT_TOKENS = 100000;
// Margin below the 100K tier threshold: the count is an estimate that can differ a little from billing,
// so inputs near the boundary are refused instead of risking the premium tier.
const MAX_INPUT_TOKENS = 90000;
const REQUEST_TIMEOUT_MS = 60000;

// Real cost of a finished call from its usage (tier chosen by prompt size).
export const costUsd = ({ input_tokens = 0, output_tokens = 0, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 }) => {
  const total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
  const p = total > LONG_PROMPT_TOKENS ? PRICE.long : PRICE.short;
  // cache tokens are billed at or below the input price; counting them at the full input price never under-states cost
  return (total * p.inputPerM + output_tokens * p.outputPerM) / 1e6;
};
// Upper bound for a call: counted input and the full output allowance at the LONG tier prices.
export const worstCaseUsd = (inputTokens, maxOutput) => (inputTokens * PRICE.long.inputPerM + maxOutput * PRICE.long.outputPerM) / 1e6;

// Messages API version header and fields follow the Haiku 5.5 docs: thinking is
// on by default and counts toward max_tokens, so max_tokens leaves room for it
// and effort is set low; no temperature/top_p/top_k; answer blocks are picked by type.
const API_VERSION = '2026-10-21';

// Safe Hebrew user messages. Never include provider text, keys or internal details.
export const AI_MSG = {
  credit: 'הקרדיט של שירות ה-AI נגמר, ולכן העוזר החכם לא זמין כרגע. פנו למנהל המערכת. שאר המערכת ממשיכה לעבוד כרגיל.',
  budget: 'תקציב השימוש בשירות ה-AI במערכת הגיע לתקרה, ולכן העוזר החכם לא זמין כרגע. פנו למנהל המערכת. שאר המערכת ממשיכה לעבוד כרגיל.',
  daily: 'הגענו למכסת הקריאות היומית של שירות ה-AI. נסו שוב מחר או פנו למנהל המערכת. שאר המערכת ממשיכה לעבוד כרגיל.',
  notConfigured: 'שירות ה-AI אינו זמין כרגע. פנו למנהל המערכת. שאר המערכת ממשיכה לעבוד כרגיל.',
};
// Anthropic reports an empty balance as a 400/402 whose error message mentions the credit balance.
const providerFailure = async (res, fallbackMsg) => {
  let text = '';
  try { text = JSON.stringify(await res.clone().json()); } catch { /* body is optional */ }
  if ((res.status === 400 || res.status === 402) && /credit balance|billing|purchase credits/i.test(text)) return Object.assign(new Error(AI_MSG.credit), { statusCode: 503, aiCreditExhausted: true });
  if (res.status === 401 || res.status === 403) return Object.assign(new Error(AI_MSG.notConfigured), { statusCode: 503 });
  return Object.assign(new Error(fallbackMsg), { statusCode: 502 });
};

// In-process ledger (tests / local scripts). Production uses createMongoLedger.
export const createMemoryLedger = ({ budgetUsd, dailyCallLimit, now = () => new Date() }) => {
  let day = ''; let calls = 0; let spent = 0; let seq = 0; const settled = new Set();
  return {
    async reserve(estUsd) {
      const today = now().toISOString().slice(0, 10);
      if (today !== day) { day = today; calls = 0; }
      if (calls >= dailyCallLimit) throw Object.assign(new Error(AI_MSG.daily), { statusCode: 429 });
      if (spent + estUsd > budgetUsd) throw Object.assign(new Error(AI_MSG.budget), { statusCode: 429 });
      calls += 1; spent += estUsd; seq += 1; return { reservationId: `m${seq}`, estUsd };
    },
    async settle(r, actual) { if (settled.has(r.reservationId)) return false; settled.add(r.reservationId); spent += actual - r.estUsd; return true; },
    async spent() { return spent; },
  };
};

export const createClaudeClient = ({
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = globalThis.fetch,
  maxOutputTokens = 4000,
  dailyCallLimit = Number(process.env.AI_DAILY_CALL_LIMIT) || 50,
  budgetUsd = Number(process.env.AI_BUDGET_USD) || 2,
  ledger = createMemoryLedger({ budgetUsd, dailyCallLimit }),
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = () => {},
} = {}) => {
  // One attempt only: no automatic retries anywhere, so every HTTP call is accounted by the ledger.
  const post = (url, payload) => fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    ledger,
    async ask({ system, prompt, content, maxOutput = maxOutputTokens }) {
      if (!apiKey) throw Object.assign(new Error(AI_MSG.notConfigured), { statusCode: 503 });
      // `content` may be a block array (document/image + text) for document reading; `prompt` stays the plain-text form.
      const messages = [{ role: 'user', content: content ?? prompt }];
      // Exact input count from Anthropic (free endpoint) for this model and payload.
      // Fails closed: no count, no generation.
      let inputTokens;
      try {
        const c = await post('https://api.anthropic.com/v1/messages/count_tokens', { model: AI_MODEL, system, messages });
        if (!c.ok) throw await providerFailure(c, 'Could not verify AI request size');
        inputTokens = (await c.json()).input_tokens;
      } catch (e) { if (e.aiCreditExhausted || e.statusCode === 503) throw e; throw Object.assign(new Error('Could not verify AI request size'), { statusCode: 502 }); }
      if (!Number.isInteger(inputTokens) || inputTokens < 0) throw Object.assign(new Error('Could not verify AI request size'), { statusCode: 502 });
      if (inputTokens > MAX_INPUT_TOKENS) throw Object.assign(new Error('Input too large'), { statusCode: 413 });
      const reservation = await ledger.reserve(worstCaseUsd(inputTokens, maxOutput));
      let res;
      try {
        res = await post('https://api.anthropic.com/v1/messages', { model: AI_MODEL, max_tokens: maxOutput, output_config: { effort: 'low' }, system, messages });
      } catch { log('ai.generate.error', { reason: 'network_or_timeout' }); throw Object.assign(new Error('AI request failed'), { statusCode: 502 }); }
      if (!res.ok) { log('ai.generate.error', { status: res.status }); throw await providerFailure(res, `AI request failed (${res.status})`); }
      const data = await res.json().catch(() => ({}));
      const u = data.usage;
      // Inconsistent usage fails closed: the worst-case reservation stays charged and nothing is returned.
      if (!u || !Number.isFinite(u.input_tokens) || !Number.isFinite(u.output_tokens) || u.input_tokens < 0 || u.output_tokens < 0) {
        log('ai.usage.invalid', { reservationId: reservation.reservationId });
        throw Object.assign(new Error('AI usage could not be verified'), { statusCode: 502 });
      }
      const cost = costUsd(u);
      if (cost > reservation.estUsd) log('ai.cost.over_reservation', { reservationId: reservation.reservationId, cost, estUsd: reservation.estUsd });
      await ledger.settle(reservation, cost);
      return {
        text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
        usage: data.usage || {}, costUsd: cost, truncated: data.stop_reason === 'max_tokens',
      };
    },
  };
};
