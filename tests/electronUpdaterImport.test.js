import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

// Regression guard for the packaged-build regression fixed in 0.2.6:
// electron-updater is CommonJS and exposes autoUpdater through a lazy
// Object.defineProperty getter. Node's ESM named-export detection
// (cjs-module-lexer) misses that getter form, so
// `({ autoUpdater } = await import('electron-updater'))` silently yielded
// undefined and the update controller started 'disabled' in every packaged
// build - the update button never appeared in the installed app.
// electron/main.js must therefore load it with createRequire.
//
// Note: the descriptor is checked instead of the value on purpose - invoking
// the getter constructs a platform updater and needs the real Electron API,
// which does not exist under vitest.
describe('electron-updater loading (packaged regression guard)', () => {
  it('exposes the autoUpdater export through CJS require', () => {
    const require = createRequire(import.meta.url);
    const mod = require('electron-updater');
    const descriptor = Object.getOwnPropertyDescriptor(mod, 'autoUpdater');
    expect(descriptor, 'autoUpdater export missing from electron-updater').toBeTruthy();
    expect(typeof descriptor.get === 'function' || 'value' in descriptor).toBe(true);
  });
});
