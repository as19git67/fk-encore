import { describe, it, expect, vi } from 'vitest'
import { findOrReanchorIndex, type ReanchorableGallery } from './galleryAnchor'

describe('findOrReanchorIndex', () => {
  it('returns the index directly when the target is already in the loaded window', async () => {
    const gallery: ReanchorableGallery = {
      findLoadedIndexById: vi.fn().mockReturnValue(5),
      reload: vi.fn().mockResolvedValue(undefined),
    }

    const idx = await findOrReanchorIndex(gallery, 42)

    expect(idx).toBe(5)
    // No re-anchor needed when the photo is already loaded.
    expect(gallery.reload).not.toHaveBeenCalled()
  })

  it('re-anchors on the target and finds it after the reload', async () => {
    // Simulates the race the album→gallery switch hit: the first page didn't
    // include the focused photo, so the initial lookup misses; reloading
    // anchored on it brings it into the window.
    const findLoadedIndexById = vi.fn()
      .mockReturnValueOnce(null) // initial window centred on the wrong page
      .mockReturnValueOnce(12)   // after re-anchor the photo is loaded
    const gallery: ReanchorableGallery = {
      findLoadedIndexById,
      reload: vi.fn().mockResolvedValue(undefined),
    }

    const idx = await findOrReanchorIndex(gallery, 42)

    expect(gallery.reload).toHaveBeenCalledOnce()
    expect(gallery.reload).toHaveBeenCalledWith({ aroundPhotoId: 42 })
    expect(idx).toBe(12)
  })

  it('returns null when the photo is genuinely absent even after re-anchoring', async () => {
    const gallery: ReanchorableGallery = {
      findLoadedIndexById: vi.fn().mockReturnValue(null),
      reload: vi.fn().mockResolvedValue(undefined),
    }

    const idx = await findOrReanchorIndex(gallery, 999)

    expect(gallery.reload).toHaveBeenCalledOnce()
    expect(idx).toBeNull()
  })
})
