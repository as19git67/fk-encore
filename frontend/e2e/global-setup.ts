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

  if (process.env.DEMO_DATA) await waitForDemo(apiURL, token)

  const outFile = path.resolve(process.cwd(), 'e2e/.auth/admin.json')
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, JSON.stringify(storageState, null, 2))

  await ctx.dispose()
}

interface DemoStatus {
  run: { id: number; status: string; stage: string | null; error: string | null } | null
}

// With DEMO_DATA set the server loads the demo household at boot, in the
// background (demo/boot.ts). The specs need its bookings, documents and
// photos, so wait until the run is through. A run that never appears (the
// database held data already) is not an error: the specs skip what they
// cannot find, as before.
async function waitForDemo(apiURL: string, token: string): Promise<void> {
  const timeoutMs = Number(process.env.E2E_DEMO_TIMEOUT_MS ?? 10 * 60_000)
  const noRunMs = 60_000
  const started = Date.now()
  const ctx = await request.newContext({ baseURL: apiURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  try {
    for (;;) {
      const res = await ctx.get('/admin/demo/status')
      if (!res.ok()) throw new Error(`[e2e] demo status failed (${res.status()}): ${await res.text().catch(() => '')}`)
      const { run } = (await res.json()) as DemoStatus
      const waited = Date.now() - started
      if (run && run.status === 'done') {
        console.log(`[e2e] demo data loaded (run ${run.id}) after ${Math.round(waited / 1000)} s`)
        return
      }
      if (run && run.status !== 'running' && run.status !== 'cancelling') {
        throw new Error(`[e2e] demo run ${run.id} ended ${run.status}: ${run.error ?? ''}`)
      }
      if (!run && waited > noRunMs) {
        console.warn('[e2e] DEMO_DATA is set but no demo run started — continuing without demo data')
        return
      }
      if (waited > timeoutMs) throw new Error(`[e2e] demo run still ${run?.status} (${run?.stage}) after ${timeoutMs / 1000} s`)
      await new Promise((r) => setTimeout(r, 2_000))
    }
  } finally {
    await ctx.dispose()
  }
}
