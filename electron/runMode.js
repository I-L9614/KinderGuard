// Decides how the desktop app runs.
//
// embedded - the machine has a local .env (the developer's PC): the app
//   starts its own server on loopback, exactly as before.
// client - every other install (customers): the installer carries no
//   secrets, so the app loads the hosted KinderGuard server over HTTPS,
//   exactly like opening the website in a browser.
//
// The hosted origin can be overridden with KINDERGUARD_SERVER_URL for tests
// and for pointing a build at a staging server; production installs use the
// default below.
export const DEFAULT_SERVER_URL = 'https://kinderguard-server.onrender.com';

export const EMBEDDED_APP_URL = 'http://127.0.0.1:4000';

export const resolveRunMode = ({ hasServerConfig, env = process.env } = {}) => {
  if (hasServerConfig) return { mode: 'embedded', appUrl: EMBEDDED_APP_URL };
  const appUrl = String(env.KINDERGUARD_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  return { mode: 'client', appUrl };
};

// The window is a client of exactly one origin. Same-origin navigations (and
// about:blank, which Electron produces internally) pass; everything else -
// external links, redirects away, injected URLs - is blocked.
export const isAllowedNavigation = (targetUrl, appUrl) => {
  try {
    const target = new URL(targetUrl);
    if (target.protocol === 'about:') return true;
    return target.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
};

// window.open policy. Everything is denied except a blob: document created by
// the app's own origin (the file the user just asked to open: a PDF or image
// fetched through the authenticated download route). It opens in a small
// sandboxed viewer window. Any other URL stays blocked.
export const decideWindowOpen = (targetUrl, appUrl) => {
  try {
    const target = new URL(targetUrl);
    const appOrigin = new URL(appUrl).origin;
    if (target.protocol === 'blob:' && target.pathname.startsWith(`${appOrigin}/`)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 780,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
  } catch {
    // fall through to deny
  }
  return { action: 'deny' };
};
