import './config/env.js';
import app from './app.js';
import connectDB from './config/db.js';
import { cleanupExpiredRefreshTokens } from './controllers/authController.js';
import { reconcileBranchDeletions } from './services/licenseCleanup.js';
import { generateDueNotifications } from './controllers/notificationController.js';
import { scheduleAllRentPayments, generateDueRentReminders, reconcileRentPaymentGroups } from './controllers/rentController.js';
import { refreshLicenseStatuses } from './controllers/licenseController.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const PORT = process.env.PORT || 4000;
// Bind host. Desktop runs (electron/main.js sets KINDERGUARD_CONFIG_DIR) are
// single-machine: the embedded server must listen on loopback only, so the
// Windows firewall has no inbound listener to prompt about and the LAN cannot
// reach the API. Standalone/web deployments keep the previous all-interfaces
// behavior, and an explicit HOST always wins.
export const resolveBindHost = (env = process.env) => env.HOST || (env.KINDERGUARD_CONFIG_DIR ? '127.0.0.1' : undefined);
const HOST = resolveBindHost();
let serverInstance;
let cleanupInterval;
let maintenanceInterval;
const safeErrorText = (error) => String(error?.message || error || 'Unknown error')
  .replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/gi, '[MongoDB URI redacted]');

export const startServer = async () => {
  if (serverInstance) return serverInstance;

  await connectDB();

  // Reject on listen errors (e.g. EADDRINUSE when the port is already taken)
  // instead of letting an unhandled 'error' event crash the main process;
  // the Electron startup flow turns this into the Hebrew startup-error dialog.
  serverInstance = await new Promise((resolve, reject) => {
    const s = app.listen(PORT, HOST, () => {
      console.log(`KinderGuard server listening on http://${HOST || 'localhost'}:${PORT}`);
      resolve(s);
    });
    s.once('error', reject);
  });

  cleanupInterval = setInterval(() => cleanupExpiredRefreshTokens(), 24 * 60 * 60 * 1000);

  const runDailyMaintenance = async () => {
    await refreshLicenseStatuses();
    await generateDueNotifications();
    await scheduleAllRentPayments();
    await reconcileRentPaymentGroups();
    await generateDueRentReminders();
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
