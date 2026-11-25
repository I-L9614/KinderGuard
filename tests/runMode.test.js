// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveRunMode, isAllowedNavigation, DEFAULT_SERVER_URL, EMBEDDED_APP_URL } from '../electron/runMode.js';

describe('resolveRunMode', () => {
  it('runs embedded with its loopback URL when a local .env exists', () => {
    expect(resolveRunMode({ hasServerConfig: true, env: {} })).toEqual({ mode: 'embedded', appUrl: EMBEDDED_APP_URL });
  });

  it('defaults customer installs (no .env) to the hosted server', () => {
    expect(resolveRunMode({ hasServerConfig: false, env: {} })).toEqual({ mode: 'client', appUrl: DEFAULT_SERVER_URL });
  });

  it('honors a KINDERGUARD_SERVER_URL override and strips trailing slashes', () => {
    expect(resolveRunMode({ hasServerConfig: false, env: { KINDERGUARD_SERVER_URL: 'https://staging.example.com/' } }))
      .toEqual({ mode: 'client', appUrl: 'https://staging.example.com' });
  });

  it('never puts the override ahead of a local .env', () => {
    expect(resolveRunMode({ hasServerConfig: true, env: { KINDERGUARD_SERVER_URL: 'https://staging.example.com' } }).mode)
      .toBe('embedded');
  });
});

describe('isAllowedNavigation', () => {
  const appUrl = 'https://kinderguard-server.onrender.com';

  it('allows same-origin navigations', () => {
    expect(isAllowedNavigation('https://kinderguard-server.onrender.com/', appUrl)).toBe(true);
    expect(isAllowedNavigation('https://kinderguard-server.onrender.com/settings?tab=team', appUrl)).toBe(true);
  });

  it('allows about:blank', () => {
    expect(isAllowedNavigation('about:blank', appUrl)).toBe(true);
  });

  it('blocks other origins, look-alike hosts and downgrades', () => {
    expect(isAllowedNavigation('https://evil.example.com', appUrl)).toBe(false);
    expect(isAllowedNavigation('https://kinderguard-server.onrender.com.evil.example.com', appUrl)).toBe(false);
    expect(isAllowedNavigation('http://kinderguard-server.onrender.com/', appUrl)).toBe(false);
  });

  it('blocks junk URLs instead of throwing', () => {
    expect(isAllowedNavigation('not a url', appUrl)).toBe(false);
  });
});

import { decideWindowOpen } from '../electron/runMode.js';

describe('decideWindowOpen', () => {
  const app = 'http://127.0.0.1:4000';
  it('allows a blob document from the app origin in a sandboxed viewer', () => {
    const r = decideWindowOpen('blob:http://127.0.0.1:4000/3f6c-aa', app);
    expect(r.action).toBe('allow');
    expect(r.overrideBrowserWindowOptions.webPreferences).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true });
  });
  it('allows a blob document from the hosted origin in client mode', () => {
    expect(decideWindowOpen('blob:https://kinderguard-server.onrender.com/abc', 'https://kinderguard-server.onrender.com').action).toBe('allow');
  });
  it('denies blobs of other origins, external pages and junk', () => {
    expect(decideWindowOpen('blob:https://evil.example/abc', app).action).toBe('deny');
    expect(decideWindowOpen('https://example.com/', app).action).toBe('deny');
    expect(decideWindowOpen('http://127.0.0.1:4000/', app).action).toBe('deny');
    expect(decideWindowOpen('not a url', app).action).toBe('deny');
  });
});
