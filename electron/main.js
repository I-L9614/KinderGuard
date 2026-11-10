import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, stopServer } from '../src/server.js';
import { setupIpcHandlers } from './ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isWindows = process.platform === 'win32';

let mainWindow = null;
let tray = null;
let isQuitting = false;

const createTrayIcon = () => {
  const size = 256;
  const canvas = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#38bdf8;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0ea5e9;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="64" fill="url(#grad)"/>
  <text x="50%" y="55%" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="140" font-weight="900" fill="#ffffff" dy="0.3em">KG</text>
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
  setupIpcHandlers();

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
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('http://localhost:4000');

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

  initializeTray();
  await createWindow();
  setAutoLaunch();
  scheduleBackgroundChecks();
}).catch(async (error) => {
  const safeMessage = String(error?.message || 'Unknown error').replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/gi, '[MongoDB URI redacted]');
  console.error('KinderGuard startup failed:', safeMessage);
  await dialog.showMessageBox({
    type: 'error',
    title: 'לא ניתן להפעיל את KinderGuard',
    message: 'האפליקציה לא הצליחה להתחבר לשירותים הנדרשים.',
    detail: 'בדקו את חיבור האינטרנט ואת הגדרות השרת, ואז נסו לפתוח מחדש. אם הבעיה נמשכת, פנו למנהל המערכת.',
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
  await stopServer();
});
