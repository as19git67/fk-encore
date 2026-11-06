/**
 * The session handover from the iOS app (documentation/plans/assistent-ios.md,
 * stage 5). The app opens `/handover#token=<one-time token>&redirect=<path>`
 * in its in-app browser. Both values travel in the fragment: a fragment never
 * leaves the browser, so neither the token nor the page lands in the server's
 * access log. The page redeems the token for a session and goes on to
 * `redirect`, validated like the login page's `?redirect=`.
 */
import { safeLoginRedirect } from './loginRedirect'

export interface HandoverParams {
  token: string | null
  /** An in-app path, or null when none was given or it was not trusted. */
  redirect: string | null
}

/** Base64url, as `crypto.randomBytes(32).toString("base64url")` writes it. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

export function parseHandoverHash(hash: string): HandoverParams {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(raw)
  const token = params.get('token')
  return {
    token: token && TOKEN_RE.test(token) ? token : null,
    redirect: safeLoginRedirect(params.get('redirect')),
  }
}
