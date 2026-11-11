// @vitest-environment node
// Regression for the v0.2.4 first-launch crash: electron/main.js imported
// src/server.js at module top level, so src/config/env.js threw "Missing
// required environment variables" BEFORE app.whenReady(). A first-launch user
// without .env got Electron's default English "JavaScript error in the main
// process" dialog. The server import is now deferred and embedded-only:
// installs WITHOUT a .env run in client mode - no secrets in the installer -
// and load the hosted KinderGuard server like a browser would.
//
// Both config probes must be false for this test: the mocked userData folder
// is empty, and the process cwd (the repo root) must not contain a .env - true
// for a clean checkout, since .env is gitignored.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_SERVER_URL } from '../electron/runMode.js';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-first-run-'));
const showMessageBox = vi.fn(async () => ({ response: 1 }));
const quit = vi.fn();
const loadURL = vi.fn();
const setWindowOpenHandler = vi.fn();
const setPermissionRequestHandler = vi.fn();
const setPermissionCheckHandler = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    on: () => {},
    quit,
    isPackaged: false,
    setAppUserModelId: () => {},
    setLoginItemSettings: () => {},
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        on: () => {},
        send: () => {},
        setWindowOpenHandler,
        session: { setPermissionRequestHandler, setPermissionCheckHandler },
      };
    }
    setMenuBarVisibility() {}
    loadURL(url) { loadURL(url); }
    once() {}
    on() {}
    show() {}
    focus() {}
    hide() {}
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromDataURL: () => ({ resize: () => ({}) }) },
  dialog: { showMessageBox },
}));

vi.mock('../electron/ipc.js', () => ({
  setupIpcHandlers: vi.fn(),
  setupUpdateIpcHandlers: vi.fn(),
}));

vi.mock('../electron/updater.js', () => ({
  createUpdateController: () => ({ getState: () => ({ status: 'disabled' }) }),
  startUpdateScheduling: () => () => {},
}));

describe('first launch without .env (client mode)', () => {
  it('loads the hosted server with the window locked to its origin - no dialog, no env crash, no quit', async () => {
    await import('../electron/main.js');
    await new Promise((r) => setTimeout(r, 100));

    // No missing-config dialog and no premature exit: client mode replaces
    // the old "copy your .env here" gate that broke customer installs.
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, '.first-run-setup-shown'))).toBe(false);

    // The packaged-smoke marker records which server the window was sent to.
    expect(fs.readFileSync(path.join(userData, '.client-mode'), 'utf8')).toBe(DEFAULT_SERVER_URL);
    expect(loadURL).toHaveBeenCalledWith(DEFAULT_SERVER_URL);

    // The navigation lockdown must be installed on the window's session.
    expect(setWindowOpenHandler).toHaveBeenCalled();
    expect(setPermissionRequestHandler).toHaveBeenCalled();
    expect(setPermissionCheckHandler).toHaveBeenCalled();
  });
});
