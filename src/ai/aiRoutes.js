import express from 'express';
import { body } from 'express-validator';
import { protect } from '../middleware/authMiddleware.js';
import { handleValidation } from '../middleware/validationMiddleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import logger from '../utils/logger.js';
import { requireAiAccess } from './aiAccess.js';
import { createClaudeClient } from './claudeClient.js';
import { createMongoLedger } from './aiLedger.js';
import { createLicenseExtractRouter } from './licenseExtract.js';
import { createTaskActionsRouter } from './taskActions.js';
import { createRentActionsRouter } from './rentActions.js';
import { createBranchActionsRouter } from './branchActions.js';
import { createBranchFileRouter } from './branchFile.js';
import { createFilePreflightRouter } from './filePreflight.js';
import { createTaskFileRouter } from './taskFile.js';
import { createTeamFileRouter } from './teamFile.js';
import { createLicenseFileRouter } from './licenseFile.js';
import { createTeamActionsRouter } from './teamActions.js';
import { createAgreementActionsRouter } from './agreementActions.js';
import { createAuthorityActionsRouter } from './authorityActions.js';
import { createLicenseActionsRouter } from './licenseActions.js';
import { createNotificationActionsRouter } from './notificationActions.js';
import { createGroupActionsRouter } from './paymentGroupActions.js';
import { createDocumentActionsRouter } from './documentActions.js';
import { createReportReadsRouter } from './reportReads.js';
import AiProposal from '../models/AiProposal.js';
import { attributionMiddleware, withUserAttribution } from './aiUserUsage.js';

const SYSTEM = 'אתה עוזר בתוך מערכת KinderGuard לניהול מעונות יום. ענה בעברית, בקצרה. הצע עדכונים בלבד: אל תבצע שינויים ואל תמציא נתונים שלא נמסרו לך.';

// Proposal-only: returns text, never writes to the database. Mounted at /api/ai
// by the caller; protect + requireAiAccess run before anything else.
const defaultClient = () => {
  // AI_BUDGET_USD=off: no app-side dollar cap (the provider's prepaid balance is the limit; its empty-credit error becomes the Hebrew notice).
  // Any other value is a finite dollar cap as before; unset keeps the safe default of 2.
  const enforceBudget = String(process.env.AI_BUDGET_USD || '').trim().toLowerCase() !== 'off';
  const budgetUsd = Number(process.env.AI_BUDGET_USD) || 2;
  // AI_DAILY_CALL_LIMIT=off: no daily call quota (calls are still counted). Anything else is the finite daily limit; unset keeps 50.
  const enforceDaily = String(process.env.AI_DAILY_CALL_LIMIT || '').trim().toLowerCase() !== 'off';
  const dailyCallLimit = Number(process.env.AI_DAILY_CALL_LIMIT) || 50;
  return createClaudeClient({ budgetUsd, dailyCallLimit, ledger: createMongoLedger({ budgetUsd, dailyCallLimit, enforceBudget, enforceDaily }), log: (event, fields) => logger.warn(event + ' ' + JSON.stringify(fields)) });
};

export const createAiRouter = ({ client: rawClient = defaultClient() } = {}) => {
  const router = express.Router(); const client = withUserAttribution(rawClient); router.use(attributionMiddleware);
  router.post('/ask', asyncHandler(protect), requireAiAccess,
    [body('prompt').isString().trim().isLength({ min: 1, max: 20000 }), handleValidation],
    asyncHandler(async (req, res) => {
      try {
        const { text, usage, costUsd, truncated } = await client.ask({ system: SYSTEM, prompt: req.body.prompt });
        res.json({ text, usage, costUsd, truncated: Boolean(truncated) });
      } catch (e) {
        res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'AI request failed' });
      }
    }));
  router.use(createLicenseExtractRouter({ client }));
  router.use(createTaskActionsRouter({ client }));
  router.use(createRentActionsRouter({ client, AiProposal }));
  router.use(createBranchActionsRouter({ client, AiProposal }));
  router.use(createBranchFileRouter({ client, AiProposal }));
  router.use(createFilePreflightRouter({ client }));
  router.use(createTaskFileRouter({ client, AiProposal }));
  router.use(createTeamFileRouter({ client, AiProposal }));
  router.use(createLicenseFileRouter({ client, AiProposal }));
  router.use(createTeamActionsRouter({ client, AiProposal }));
  router.use(createAgreementActionsRouter({ client, AiProposal }));
  router.use(createAuthorityActionsRouter({ client, AiProposal }));
  router.use(createLicenseActionsRouter({ client, AiProposal }));
  router.use(createNotificationActionsRouter({ client, AiProposal }));
  router.use(createGroupActionsRouter({ client, AiProposal }));
  router.use(createDocumentActionsRouter({ AiProposal }));
  router.use(createReportReadsRouter({ client }));
  return router;
};
