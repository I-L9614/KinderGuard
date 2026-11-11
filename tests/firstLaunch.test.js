// @vitest-environment node
// Regression for the v0.2.4 first-launch crash: electron/main.js imported
// src/server.js at module top level, so src/config/env.js threw "Missing
// required environment variables" BEFORE app.whenReady(). A first-launch user
// without .env got Electron's default English "JavaScript error in the main
// process" dialog instead of the Hebrew missing-config dialog. The server
// import is now deferred past the hasServerConfig gate. With the old code,
// the import on line 41 itself throws and this test fails at import time.
//
// Both config probes must be false for this test: the mocked userData folder
// is empty, and the process cwd (the repo root) must not contain a .env - true
// for a clean checkout, since .env is gitignored.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-first-run-'));
const showMessageBox = vi.fn(async () => ({ response: 1 }));
const quit = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    on: () => {},
    quit,
    isPackaged: true,
    setAppUserModelId: () => {},
  },
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromDataURL: () => ({}) },
  dialog: { showMessageBox },
  shell: { openPath: vi.fn(async () => '') },
}));

describe('first launch without .env', () => {
  it('reaches the Hebrew setup dialog instead of an uncaught env crash', async () => {
    await import('../electron/main.js');
    await new Promise((r) => setTimeout(r, 100));
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const dialogOptions = showMessageBox.mock.calls[0][0];
    expect(dialogOptions.title).toBe('נדרש קובץ הגדרות');
    expect(dialogOptions.detail).toContain('.env');
    expect(quit).toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, '.first-run-setup-shown'))).toBe(true);
  });
});
