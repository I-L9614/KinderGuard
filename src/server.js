import './config/env.js';
import app from './app.js';
import connectDB from './config/db.js';
import { cleanupExpiredRefreshTokens } from './controllers/authController.js';
import { reconcileBranchDeletions } from './services/licenseCleanup.js';
import { generateDueNotifications } from './controllers/notificationController.js';
import { refreshLicenseStatuses } from './controllers/licenseController.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const PORT = process.env.PORT || 4000;
let serverInstance;
let cleanupInterval;
let maintenanceInterval;
const safeErrorText = (error) => String(error?.message || error || 'Unknown error')
  .replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/gi, '[MongoDB URI redacted]');

export const startServer = async () => {
  if (serverInstance) return serverInstance;

  await connectDB();

  serverInstance = app.listen(PORT, () => {
    console.log(`KinderGuard server listening on http://localhost:${PORT}`);
  });

  cleanupInterval = setInterval(() => cleanupExpiredRefreshTokens(), 24 * 60 * 60 * 1000);

  const runDailyMaintenance = async () => {
    await refreshLicenseStatuses();
    await generateDueNotifications();
    await reconcileBranchDeletions();
  };
  runDailyMaintenance().catch((err) => console.error('License maintenance failed:', safeErrorText(err)));
  maintenanceInterval = setInterval(() => {
    runDailyMaintenance().catch((err) => console.error('License maintenance failed:', safeErrorText(err)));
  }, 60 * 60 * 1000);

  return serverInstance;
};

export const stopServer = async () => {
  if (!serverInstance) return;
  serverInstance.close();
  clearInterval(cleanupInterval);
  clearInterval(maintenanceInterval);
  serverInstance = null;
};

if (process.argv[1] === __filename) {
  startServer().catch((err) => {
    console.error('Failed to start server:', safeErrorText(err));
    process.exit(1);
  });
}
