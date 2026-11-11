import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { setupIpcHandlers, setupUpdateIpcHandlers } from './ipc.js';
import { createUpdateController, startUpdateScheduling } from './updater.js';

// The embedded server's configuration (.env with MONGO_URI, JWT_SECRET and
// the S3 settings) lives in the per-user data folder, outside the install
// directory, so updates never touch it. env.js reads KINDERGUARD_CONFIG_DIR;
// it must be set BEFORE the server module loads, hence the dynamic import.
const configDir = app.getPath('userData');
process.env.KINDERGUARD_CONFIG_DIR = configDir;
const hasServerConfig = fs.existsSync(path.join(configDir, '.env')) || fs.existsSync(path.resolve(process.cwd(), '.env'));
// The server module loads src/config/env.js, which throws when the .env is
// missing. Importing it here at module top level crashed the main process
// BEFORE app.whenReady(), so first-launch users got Electron's default
// English "JavaScript error" dialog instead of the Hebrew missing-config
// dialog below. The import is deferred into the whenReady flow, after the
// hasServerConfig gate, where the .catch turns failures into the Hebrew
// startup-error dialog.
let startServer = null;
let stopServer = async () => {};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isWindows = process.platform === 'win32';

let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateController = null;
let stopUpdateScheduling = () => {};

// The update button flow: checks GitHub Releases in the background, shows a
// yellow dot when a newer version exists, and only after the user clicks and
// approves does it download and install. quitAndInstall closes the app itself.
// In unpackaged runs (npm run electron / tests) updates stay disabled.
const setupUpdates = async () => {
  let autoUpdater = null;
  if (app.isPackaged) {
    try {
      // electron-updater is CommonJS and exposes autoUpdater via a lazy
      // defineProperty getter that Node's ESM named-export detection misses:
      // `await import('electron-updater')` yields autoUpdater=undefined, which
      // silently started the controller 'disabled' in every packaged build
      // before 0.2.6 (the update button never appeared). CJS require() gets
      // the real exports object with the working getter.
      const require = createRequire(import.meta.url);
      ({ autoUpdater } = require('electron-updater'));
    } catch (error) {
      console.error('electron-updater unavailable:', error?.message || 'Unknown error');
    }
  }
  updateController = createUpdateController({
    autoUpdater,
    isPackaged: app.isPackaged,
    send: (status) => { if (mainWindow) mainWindow.webContents.send('update-status', status); },
    log: (message) => console.log('[updates]', message),
  });
  // Packaged-smoke marker: proves the updater actually loaded in the real
  // packaged runtime (a 'disabled' state here means the button is hidden).
  try { fs.writeFileSync(path.join(configDir, '.update-state'), updateController.getState().status); } catch {}
  setupUpdateIpcHandlers(() => updateController);
  stopUpdateScheduling = startUpdateScheduling(updateController);
};

const createTrayIcon = () => {
  // Approved KinderGuard v2 logo: dark teal square, mint shield, white K, amber dot.
  // Keep in sync with build/icon.svg.
  const canvas = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f3d4a"/><stop offset="1" stop-color="#051c26"/></linearGradient>
    <linearGradient id="mt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#14a89a"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#bg)"/>
  <path d="M256 84 L392 130 V250 C392 328 336 386 256 428 C176 386 120 328 120 250 V130 Z" fill="none" stroke="url(#mt)" stroke-width="22" stroke-linejoin="round"/>
  <path d="M214 180 V328" stroke="#fff" stroke-width="26" stroke-linecap="round"/>
  <path d="M300 180 L226 254 L304 328" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="306" cy="176" r="19" fill="#fbbf24"/>
</svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(canvas).toString('base64')}`).resize({ width: 32, height: 32 });
};

const setAutoLaunch = () => {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe'),
      args: ['--hidden'],
    });
  } catch (error) {
    console.error('Failed to configure auto launch:', error?.message || 'Unknown error');
  }
};

const getTrayMenu = () => {
  return Menu.buildFromTemplate([
    {
      label: 'הצג KinderGuard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'בדוק התראות עכשיו',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('notification-refresh-requested');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'יציאה',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
};

const initializeTray = () => {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('KinderGuard');
  tray.setContextMenu(getTrayMenu());
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });
};

const createWindow = async () => {
  await startServer();
  setupIpcHandlers(() => mainWindow);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    show: false,
    icon: createTrayIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Bridge diagnostics: if the preload fails to load (e.g. it stops being
  // CJS) window.electronAPI never appears and in-app features die quietly.
  // Record both outcomes in userData so tests and support can tell.
  mainWindow.webContents.on('preload-error', (_event, _path, error) => {
    console.error('Preload failed to load:', error?.message || error);
    try { fs.writeFileSync(path.join(configDir, '.preload-error'), String(error?.message || error)); } catch {}
  });
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const bridgeOk = await mainWindow.webContents.executeJavaScript('Boolean(window.electronAPI && window.electronAPI.notify)');
      fs.writeFileSync(path.join(configDir, bridgeOk ? '.bridge-ok' : '.bridge-missing'), new Date().toISOString());
      if (!bridgeOk) console.error('window.electronAPI missing in the renderer - check the preload script');
    } catch (error) {
      console.error('bridge self-check failed:', error?.message || error);
    }
  });

  // 127.0.0.1, not 'localhost': the server binds IPv4 loopback only, and on
  // some Windows machines localhost resolves to ::1 first.
  mainWindow.loadURL('http://127.0.0.1:4000');

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) {
      mainWindow.show();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
};

const scheduleBackgroundChecks = () => {
  setInterval(() => {
    if (mainWindow) mainWindow.webContents.send('notification-refresh-requested');
  }, 15 * 60 * 1000);
};

const handleSingleInstance = () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return true;
};

if (!handleSingleInstance()) {
  process.exit(0);
}

app.whenReady().then(async () => {
  if (isWindows) {
    app.setAppUserModelId('com.kinderguard.desktop');
  }

  // First launch after installing: without the configuration file the app
  // cannot start. Say exactly what is missing and where it goes, and offer
  // to open that folder.
  if (!hasServerConfig) {
    fs.mkdirSync(configDir, { recursive: true });
    // Marker for the packaged first-launch test: proves this dialog was
    // reached (the v0.2.4 crash happened before it, leaving no marker).
    fs.writeFileSync(path.join(configDir, '.first-run-setup-shown'), new Date().toISOString());
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'נדרש קובץ הגדרות',
      message: 'KinderGuard צריך את קובץ ההגדרות (.env) כדי לפעול.',
      detail: `העתיקו את קובץ ה-.env שלכם (עם MONGO_URI, JWT_SECRET והגדרות ה-S3) אל התיקייה:\n${configDir}\n\nאם התקנתם בעבר והקובץ קיים שם, פשוט הפעילו מחדש. בלחיצה על \"פתיחת התיקייה\" התיקייה תיפתח כדי שתוכלו להעתיק אליה את הקובץ.`,
      buttons: ['פתיחת התיקייה', 'סגירה'],
    });
    if (choice.response === 0) {
      await shell.openPath(configDir);
    }
    app.quit();
    return;
  }

  ({ startServer, stopServer } = await import('../src/server.js'));
  initializeTray();
  await createWindow();
  setAutoLaunch();
  scheduleBackgroundChecks();
  await setupUpdates();
}).catch(async (error) => {
  const safeMessage = String(error?.message || 'Unknown error').replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/gi, '[MongoDB URI redacted]');
  console.error('KinderGuard startup failed:', safeMessage);
  // Marker for the packaged bad-config test: proves failures land in this
  // Hebrew error dialog rather than an uncaught main-process crash.
  try { fs.writeFileSync(path.join(configDir, '.startup-error-shown'), new Date().toISOString()); } catch {}
  const portInUse = error?.code === 'EADDRINUSE';
  await dialog.showMessageBox({
    type: 'error',
    title: 'לא ניתן להפעיל את KinderGuard',
    message: portInUse ? 'לא ניתן להפעיל: פורט 4000 תפוס.' : 'האפליקציה לא הצליחה להתחבר לשירותים הנדרשים.',
    detail: portInUse
      ? 'כנראה שעותק נוסף של התוכנה או תוכנית אחרת משתמשים בפורט. סגרו עותקים פתוחים של KinderGuard (כולל מהמגש ליד השעון) ונסו שוב. אם הבעיה נמשכת, פנו למנהל המערכת.'
      : 'בדקו את חיבור האינטרנט ואת הגדרות השרת, ואז נסו לפתוח מחדש. אם הבעיה נמשכת, פנו למנהל המערכת.',
    buttons: ['סגירה'],
  });
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', async () => {
  stopUpdateScheduling();
  await stopServer();
});
