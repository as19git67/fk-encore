import { request, type APIRequestContext } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000'

let cached: { ctx: APIRequestContext; token: string } | null = null

// Returns an authenticated APIRequestContext bound to the admin from
// globalSetup. Used by specs that need to seed/cleanup data through the
// REST API rather than driving the UI.
export async function adminApi(): Promise<{ ctx: APIRequestContext; token: string }> {
  if (cached) return cached

  const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com'
  const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin'

  const bootstrap = await request.newContext({ baseURL: API_URL })
  const res = await bootstrap.post('/auth/login', { data: { email, password } })
  if (!res.ok()) {
    throw new Error(`[e2e] adminApi login failed: ${res.status()} ${await res.text()}`)
  }
  const { token } = (await res.json()) as { token: string }
  await bootstrap.dispose()

  const ctx = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  cached = { ctx, token }
  return cached
}

export const apiBaseURL = API_URL
