/** One year. The cookie holds only a public GitHub username, never a secret. */
export const LAST_LOGIN_MAX_AGE = 365 * 24 * 60 * 60;

/** A GitHub username, or null. GitHub allows 1-39 letters, digits and single hyphens. */
export function lastLogin(value: string | undefined | null): string | null {
  return value && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value) ? value : null;
}
