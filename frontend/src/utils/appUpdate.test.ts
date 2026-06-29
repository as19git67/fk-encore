import { describe, expect, it, vi } from 'vitest'
import { createAppUpdateMonitor, isStaleChunkLoadError } from './appUpdate'

describe('isStaleChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'error loading dynamically imported module',
    'Loading chunk abc failed',
    'ChunkLoadError: chunk 17',
    'Unable to preload CSS',
    'The string did not match the expected pattern.',
  ])('recognises stale deployment errors: %s', (message) => {
    expect(isStaleChunkLoadError(new Error(message))).toBe(true)
  })

  it('does not classify ordinary application failures as stale chunks', () => {
    expect(isStaleChunkLoadError(new Error('permission denied'))).toBe(false)
  })
})

describe('createAppUpdateMonitor', () => {
  it('reloads exactly once when server and client builds differ', async () => {
    const reload = vi.fn()
    const fetchBuild = vi.fn().mockResolvedValue({ build: 'new-build' })
    const monitor = createAppUpdateMonitor({
      clientBuild: 'old-build',
      fetchBuild,
      reload,
    })

    expect(await monitor.check()).toBe(true)
    expect(await monitor.check()).toBe(false)
    expect(fetchBuild).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the page when the build matches or lookup fails', async () => {
    const reload = vi.fn()
    const matching = createAppUpdateMonitor({
      clientBuild: 'same-build',
      fetchBuild: vi.fn().mockResolvedValue({ build: 'same-build' }),
      reload,
    })
    const unavailable = createAppUpdateMonitor({
      clientBuild: 'same-build',
      fetchBuild: vi.fn().mockRejectedValue(new Error('offline')),
      reload,
    })

    expect(await matching.check()).toBe(false)
    expect(await unavailable.check()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not pollute local development with reload loops', async () => {
    const fetchBuild = vi.fn().mockResolvedValue({ build: 'production' })
    const reload = vi.fn()
    const monitor = createAppUpdateMonitor({ clientBuild: 'dev', fetchBuild, reload })

    expect(await monitor.check()).toBe(false)
    expect(fetchBuild).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})
