/**
 * Where to go after signing in.
 *
 * A shared link to a detail page used to be lost at the login wall: the
 * router sent the visitor to `/login`, and after signing in they landed on
 * their last-visited page instead of the link's target. The router now puts
 * the refused path into `?redirect=`, and the login page navigates there.
 *
 * The value comes from the URL, so it is validated: only an in-app path is
 * accepted — never an absolute URL (`https://…`, `//evil`), which would turn
 * the login page into an open redirect, and never one of the public auth
 * pages, which would bounce a signed-in user back to a login form.
 */

const AUTH_PATH_PREFIXES = ['/login', '/register', '/forgot-password']

export function safeLoginRedirect(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw === '/') return null
  // Backslashes are treated like slashes by some URL parsers ("/\evil.test"),
  // so a path containing one is not trusted.
  if (raw.includes('\\')) return null
  if (AUTH_PATH_PREFIXES.some((p) => raw === p || raw.startsWith(`${p}/`) || raw.startsWith(`${p}?`))) {
    return null
  }
  return raw
}
