import { describe, it, expect, beforeEach, vi } from 'vitest'

const STORAGE_KEY = 'focus_peaking_enabled'

async function freshComposable() {
  vi.resetModules()
  const mod = await import('./useFocusPeaking')
  return mod.useFocusPeaking()
}

describe('useFocusPeaking', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to enabled when nothing is stored', async () => {
    const fp = await freshComposable()
    expect(fp.enabled.value).toBe(true)
  })

  it('restores an explicit "off" choice', async () => {
    localStorage.setItem(STORAGE_KEY, 'false')
    const fp = await freshComposable()
    expect(fp.enabled.value).toBe(false)
  })

  it('persists the toggle', async () => {
    const fp = await freshComposable()
    fp.toggle()
    expect(fp.enabled.value).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
    fp.toggle()
    expect(fp.enabled.value).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
  })

  it('shares state across call sites', async () => {
    vi.resetModules()
    const mod = await import('./useFocusPeaking')
    const a = mod.useFocusPeaking()
    const b = mod.useFocusPeaking()
    a.setEnabled(false)
    expect(b.enabled.value).toBe(false)
  })

  it('survives an unavailable localStorage', async () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    try {
      const fp = await freshComposable()
      expect(fp.enabled.value).toBe(true)
      fp.setEnabled(false)
      expect(fp.enabled.value).toBe(false)
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('reports no scores for an unmeasured photo', async () => {
    const fp = await freshComposable()
    expect(fp.scoresFor(42)).toBeUndefined()
  })

  it('skips measuring when the image has no decoded dimensions', async () => {
    const fp = await freshComposable()
    const img = document.createElement('img')
    fp.measure(7, img, [
      {
        id: 1,
        user_id: 1,
        photo_id: 7,
        bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        ignored: false,
        created_at: '2026-01-01T00:00:00Z',
      },
    ])
    expect(fp.scoresFor(7)).toBeUndefined()
  })
})
