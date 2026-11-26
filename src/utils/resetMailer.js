import logger from './logger.js';
import { maskEmail } from './passwordPolicy.js';

// Password reset mailer. Sends through the Gmail API over HTTPS with the
// dedicated KinderGuard sender account; hosted free tiers block SMTP, so API
// send is the supported path. The transport is injectable so tests run with a
// mock and no real mail can ever leave the test suite.
//
// Live sends require env on the server only (never in the repo):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER
// With any of them missing the send is skipped and logged with a masked
// address, which keeps local/dev/test runs safe.

export const RESET_SUBJECT = 'איפוס סיסמה ל־KinderGuard';

let transportOverride = null;
export const setResetMailTransport = (transport) => { transportOverride = transport; };

export const buildResetEmailText = ({ name, resetUrl, ttlMinutes }) => [
  `שלום ${name},`,
  '',
  'התקבלה בקשה לאיפוס הסיסמה לחשבון שלך ב־KinderGuard.',
  '',
  `לאיפוס, פתחו את הקישור הבא (תקף ל־${ttlMinutes} דקות, לשימוש חד־פעמי):`,
  resetUrl,
  '',
  'אם לא ביקשתם איפוס, אפשר להתעלם מההודעה. הסיסמה לא תשתנה.',
  '',
  'KinderGuard',
].join('\r\n');

const encodeSubject = (subject) => `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

const buildRfc822 = ({ from, to, subject, text }) => [
  `From: KinderGuard <${from}>`,
  `To: ${to}`,
  `Subject: ${encodeSubject(subject)}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(text, 'utf8').toString('base64'),
].join('\r\n');

const base64url = (value) => Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const getAccessToken = async () => {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token exchange failed (${res.status})`);
  return (await res.json()).access_token;
};

const gmailTransport = async ({ to, subject, text }) => {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_SENDER) {
    logger.warn(`Password reset email skipped - Gmail sender env not configured (to ${maskEmail(to)})`);
    return { skipped: true };
  }
  const accessToken = await getAccessToken();
  const raw = base64url(buildRfc822({ from: GMAIL_SENDER, to, subject, text }));
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status})`);
  return res.json();
};

export const sendPasswordResetEmail = async ({ to, name, resetUrl, ttlMinutes }) => {
  const transport = transportOverride || gmailTransport;
  return transport({ to, subject: RESET_SUBJECT, text: buildResetEmailText({ name, resetUrl, ttlMinutes }) });
};
