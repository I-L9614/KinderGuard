import { AsyncLocalStorage } from 'async_hooks';
import AiUserUsage from '../models/AiUserUsage.js';
import { getAdminId } from '../utils/access.js';
import logger from '../utils/logger.js';

// Attribution only: wraps client.ask, never changes its result or error, never gates a call, never touches the global ledger.
const als = new AsyncLocalStorage();
export const attributionMiddleware = (req, res, next) => als.run({ req }, next);
export const withUserAttribution = (client) => ({
  ...client,
  ask: async (opts) => {
    try { return await client.ask(opts); }
    finally {
      const user = als.getStore()?.req?.user;
      if (user?._id) {
        const day = new Date().toISOString().slice(0, 10);
        AiUserUsage.updateOne({ adminId: getAdminId(user), userId: user._id, day }, { $inc: { attempts: 1 } }, { upsert: true }).catch((e) => logger.warn(`ai.usage.write_failed ${String(e.message).slice(0, 120)}`));
      }
    }
  },
});
