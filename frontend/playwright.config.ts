import { defineConfig, devices } from '@playwright/test'

// Defaults for a local stack:
//   - Encore backend on :4000 (started with `encore run`)
//   - Vite dev server on :5173 with `/api` proxy → :4000
//   - SPA mounted under `/app/` (see vite.config.ts `base`)
//
// CI or remote runs can override via env:
//   E2E_BASE_URL    e.g. http://localhost:5173/app/
//   E2E_API_URL     e.g. http://localhost:4000  (used by globalSetup for seeding/login)
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD  credentials for the seeded admin
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173/app/'

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: './e2e/.report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: './e2e/.report' }]],

  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Use the storageState produced by globalSetup so individual specs
    // start authenticated. Tests that need a clean session can override.
    storageState: './e2e/.auth/admin.json',
    // Realistic input timing: PrimeVue overlays animate, virtualized
    // grids hydrate after scroll — give actions a generous default.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Track M targets desktop input first; uncomment to broaden:
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari']  } },
  ],

  // Auto-start the Vite dev server when running locally. Disable in CI by
  // setting E2E_NO_WEBSERVER=1 (the pipeline will manage encore + vite).
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173/app/',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
