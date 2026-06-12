export const API_BASE_URL = import.meta.env.PROD ? '' : '/api'

const REFRESH_BUFFER_SECONDS = 60

function tokenExpiresWithin(token: string, seconds: number): boolean {
  try {
    const part = token.split('.')[1]
    if (!part) return false
    const payload = JSON.parse(atob(part))
    return payload.exp * 1000 - Date.now() < seconds * 1000
  } catch {
    return false
  }
}

let refreshPromise: Promise<boolean> | null = null

async function tryRefresh(staleToken: string | null): Promise<boolean> {
  // Another tab may have already refreshed — check if the token
  // in localStorage is newer than the one that triggered the 401.
  const currentToken = localStorage.getItem('auth_token')
  if (currentToken && currentToken !== staleToken) return true

  const refreshToken = localStorage.getItem('refresh_token')
  if (!refreshToken) return false

  // Deduplicate: if a refresh is already in-flight, wait for it
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })

      if (!response.ok) return false

      const data = await response.json()
      localStorage.setItem('auth_token', data.token)
      localStorage.setItem('refresh_token', data.refreshToken)
      localStorage.setItem('auth_user', JSON.stringify(data.user))
      return true
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

export async function ensureFreshToken(): Promise<void> {
  const token = localStorage.getItem('auth_token')
  if (token && tokenExpiresWithin(token, REFRESH_BUFFER_SECONDS)) {
    await tryRefresh(token)
  }
}

export interface ApiFetchOptions extends RequestInit {
  /**
   * Abort the request after this many milliseconds. Prevents hanging requests
   * from accumulating in the browser when the server is overloaded — critical
   * for polling/batch endpoints because dangling fetches keep their response
   * buffers in memory and can OOM the tab.
   */
  timeoutMs?: number
}

/**
 * Combine an external AbortSignal with an internal timeout signal.
 * Returns the combined signal plus a cleanup that clears the timer so
 * the request doesn't keep a setTimeout pinned after it resolves.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal | undefined
  cleanup: () => void
} {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }

  return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  let token = localStorage.getItem('auth_token')

  // Proactively refresh before the token expires to avoid 401 round-trips
  if (token && tokenExpiresWithin(token, REFRESH_BUFFER_SECONDS) && path !== '/auth/refresh') {
    const refreshed = await tryRefresh(token)
    if (refreshed) token = localStorage.getItem('auth_token')
  }

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  }

  // Set default content type only if not already specified and body is not binary/form
  if (!headers['Content-Type'] && !(options.body instanceof FormData || options.body instanceof Blob || options.body instanceof File)) {
    headers['Content-Type'] = 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const { timeoutMs, signal: callerSignal, ...fetchInit } = options
  const { signal, cleanup } = withTimeout(callerSignal ?? undefined, timeoutMs)

  try {
    let response = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchInit,
      headers,
      signal,
    })

    // On 401, try refreshing the access token and retry once
    if (response.status === 401 && path !== '/auth/refresh') {
      const refreshed = await tryRefresh(token)
      if (refreshed) {
        const newToken = localStorage.getItem('auth_token')
        headers['Authorization'] = `Bearer ${newToken}`
        response = await fetch(`${API_BASE_URL}${path}`, {
          ...fetchInit,
          headers,
          signal,
        })
      }
    }

    if (response.status === 401 && path !== '/auth/login') {
      // A 401 *after* we had a token means the session expired mid-use —
      // clear it and bounce to login. With no token the caller is
      // browsing anonymously (e.g. a public shared album), so surface the
      // error for the caller to handle instead of yanking the guest to
      // the login screen. Route protection for logged-in areas is handled
      // by the router guard, not here.
      if (token) {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('refresh_token')
        localStorage.removeItem('auth_user')
        window.location.href = `${import.meta.env.BASE_URL}login`
      }
      throw new Error('Unauthorized')
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || body.code || `Request failed: ${response.status}`)
    }

    return response.json()
  } finally {
    cleanup()
  }
}
