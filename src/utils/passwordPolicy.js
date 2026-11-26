// Password policy for newly set passwords (registration, manager-created
// users). The login validator keeps its old shape so a stricter policy can
// never lock an existing user out of sign-in.
export const PASSWORD_MIN_LENGTH = 10;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', '12345678', '123456789', '1234567890',
  'qwerty123', '1111111111', '123123123', 'iloveyou', '1q2w3e4r5t',
  'abcd1234', 'letmein123', 'qazwsx123', '12345678910',
]);

export const PASSWORD_POLICY_MESSAGE = 'הסיסמה חייבת להכיל לפחות 10 תווים ולא להיות סיסמה נפוצה.';

export const passwordPolicyError = (password) => {
  const pw = String(password || '');
  if (pw.length < PASSWORD_MIN_LENGTH) return PASSWORD_POLICY_MESSAGE;
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return PASSWORD_POLICY_MESSAGE;
  return null;
};

// Keeps logs useful for debugging without storing full personal addresses.
export const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
};
