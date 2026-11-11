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
