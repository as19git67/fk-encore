// Standalone vitest config for the frontend package. The root vitest
// config excludes frontend/** because the backend tests run against a
// Postgres instance that the frontend tests have no need for; this file
// keeps frontend tests isolated, runs them under jsdom, and pins the
// tsconfig so vite:oxc can resolve test files (the frontend's main
// tsconfig.app.json explicitly excludes them).
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    globals: true,
    typecheck: {
      tsconfig: './tsconfig.vitest.json',
    },
  },
  esbuild: {
    // Match the test tsconfig so the transformer doesn't fall back to
    // tsconfig.app.json (which excludes test files and trips vite:oxc with
    // "Tsconfig not found" — that's the exact CI failure we're fixing).
    tsconfigRaw: undefined,
  },
})
