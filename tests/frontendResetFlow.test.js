// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/#reset=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
// Boots the real frontend with a reset-link hash and drives the reset form:
// mismatched confirmation is blocked locally, a matching pair posts the token
// and new password, and success clears the hash back to the login screen.
import { describe, it, expect, beforeAll, vi } from 'vitest';

let fetchMock;
const TOKEN = 'a'.repeat(64);

beforeAll(async () => {
  document.body.innerHTML = `
    <header><div id="update-slot"></div><div id="header-actions"></div></header>
    <main id="app" class="content">טוען...</main>
    <span id="server-origin" hidden></span>`;
  fetchMock = vi.fn((url) => {
    const u = String(url);
    const reply = (ok, status, payload) => Promise.resolve({ ok, status, text: async () => JSON.stringify(payload) });
    if (u.includes('/api/users/password/reset')) return reply(true, 200, { message: 'הסיסמה עודכנה. התחברו עם הסיסמה החדשה.' });
    return reply(false, 401, { message: 'no session' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('../frontend/main.js');
  await vi.waitFor(() => {
    if (!document.getElementById('resetForm')) throw new Error('reset screen not rendered yet');
  });
});

describe('frontend reset-password flow', () => {
  it('opens the reset screen from the link hash without calling the app', () => {
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/refresh'))).toBe(false);
    expect(document.querySelector('.auth-title').textContent).toBe('בחירת סיסמה חדשה');
  });

  it('blocks mismatched confirmation locally, then posts token and password once matching', async () => {
    const form = document.getElementById('resetForm');
    form.querySelector('input[name="password"]').value = 'NewPassword9876';
    form.querySelector('input[name="confirm"]').value = 'DifferentPass11';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/users/password/reset'))).toBe(false);

    form.querySelector('input[name="confirm"]').value = 'NewPassword9876';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => {
      if (!fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/users/password/reset'))) throw new Error('reset not called yet');
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/users/password/reset'));
    expect(JSON.parse(call[1].body)).toEqual({ token: TOKEN, password: 'NewPassword9876' });
    await vi.waitFor(() => {
      if (!document.getElementById('authForm')) throw new Error('login screen not restored yet');
    });
    expect(location.hash).toBe('');
  });
});
