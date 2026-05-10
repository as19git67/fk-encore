import { request, type FullConfig } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

// Logs the seeded admin in once and writes a Playwright storageState
// snapshot that pre-populates localStorage with auth_token / refresh_token /
// auth_user. The auth store reads exactly these keys on boot, so every spec
// starts authenticated without re-running the form-driven login flow.
//
// The login spec deliberately overrides storageState to test the form path.
export default async function globalSetup(config: FullConfig) {
  const baseURL =
    process.env.E2E_BASE_URL ??
    config.projects[0]?.use?.baseURL ??
    'http://localhost:5173/app/'
  const apiURL = process.env.E2E_API_URL ?? 'http://localhost:4000'
  const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com'
  const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin'

  const ctx = await request.newContext({ baseURL: apiURL })
  const res = await ctx.post('/auth/login', { data: { email, password } })

  if (!res.ok()) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `[e2e] Admin login failed (${res.status()}): ${body}\n` +
        `Set E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD or run the seed first.`,
    )
  }

  const { token, refreshToken, user } = (await res.json()) as {
    token: string
    refreshToken: string
    user: unknown
  }

  // Origin for localStorage must match where the SPA runs. Strip trailing
  // path so the storageState applies to all routes under that origin.
  const origin = new URL(baseURL).origin

  const storageState = {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: 'auth_token', value: token },
          { name: 'refresh_token', value: refreshToken },
          { name: 'auth_user', value: JSON.stringify(user) },
        ],
      },
    ],
  }

  const outFile = path.resolve(process.cwd(), 'e2e/.auth/admin.json')
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, JSON.stringify(storageState, null, 2))

  await ctx.dispose()
}
