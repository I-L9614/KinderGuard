// @vitest-environment jsdom
// Renders the real frontend boot in jsdom and drives the forgot-password
// screen: login -> שכחתי סיסמה -> submit. Asserts the actual fetch call the
// browser would make and the confirmation text the user sees.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const GENERIC = 'אם הפרטים תואמים חשבון קיים, נשלח אליו קישור לאיפוס הסיסמה.';
let fetchMock;

beforeAll(async () => {
  document.body.innerHTML = `
    <header><div id="update-slot"></div><div id="header-actions"></div></header>
    <main id="app" class="content">טוען...</main>
    <span id="server-origin" hidden></span>`;
  fetchMock = vi.fn((url) => {
    const u = String(url);
    const reply = (ok, status, payload) => Promise.resolve({ ok, status, text: async () => JSON.stringify(payload) });
    if (u.includes('/api/users/password/forgot')) return reply(true, 200, { message: GENERIC });
    return reply(false, 401, { message: 'no session' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('../frontend/main.js');
  await vi.waitFor(() => {
    if (!document.getElementById('authForm')) throw new Error('login screen not rendered yet');
  });
});

describe('frontend forgot-password flow', () => {
  it('login screen offers שכחתי סיסמה and the form posts the identifier to the forgot endpoint', async () => {
    document.getElementById('forgotLink').click();
    const form = document.getElementById('forgotForm');
    expect(form).toBeTruthy();
    form.querySelector('input[name="identifier"]').value = 'איתמר לוי';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => {
      if (!fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/users/password/forgot'))) throw new Error('forgot not called yet');
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/users/password/forgot'));
    expect(JSON.parse(call[1].body)).toEqual({ identifier: 'איתמר לוי' });
    await vi.waitFor(() => {
      if (!document.getElementById('forgotHint').textContent.includes('בדקו את תיבת הדוא״ל')) throw new Error('confirmation not shown yet');
    });
    expect(document.getElementById('forgotHint').textContent).toContain(GENERIC);
  });

  it('back link returns to the login screen', async () => {
    // The previous test left us on the forgot screen.
    document.getElementById('backToLogin').click();
    expect(document.getElementById('authForm')).toBeTruthy();
    expect(document.getElementById('forgotLink')).toBeTruthy();
  });
});
