// Rules for a staff password. These guard against guessable passwords on an
// account that can read and change a hospital's financial data. Length does
// most of the work; the list catches the obvious ones.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const BANNED_FRAGMENTS = ["password", "welli", "qwerty", "123456", "abcdef", "letmein", "admin", "iloveyou"];

// Returns a plain-language problem, or null if the password is acceptable.
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (new Set(password).size < 5) return "Use a password with more variety of characters.";
  const lower = password.toLowerCase();
  if (BANNED_FRAGMENTS.some((f) => lower.includes(f))) return "That password is too easy to guess. Avoid common words and number runs.";
  const name = email?.split("@")[0]?.toLowerCase();
  if (name && name.length >= 4 && lower.includes(name)) return "The password must not contain your email name.";
  return null;
}
