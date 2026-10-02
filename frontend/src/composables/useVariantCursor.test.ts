import { describe, it, expect } from 'vitest'
import { nextTick, ref } from 'vue'
import { useVariantCursor } from './useVariantCursor'
import type { Photo } from '../api/photos'
import type { ScreenOrientation } from './useScreenOrientation'

const photo = (id: number, orientation: 'portrait' | 'landscape'): Photo => ({
  id, user_id: 1, filename: `${id}.jpg`, original_name: `${id}.jpg`, mime_type: 'image/jpeg',
  size: 1, created_at: '', curation_status: 'visible', orientation,
})

function setup(screen: ScreenOrientation) {
  const screenRef = ref<ScreenOrientation>(screen)
  const cursorPhoto = ref<Photo | null>(photo(1, 'landscape'))
  const vc = useVariantCursor({ screen: screenRef, cursorPhoto })
  return { screenRef, cursorPhoto, vc }
}

describe('useVariantCursor', () => {
  it('swaps the two photos on toggle and pins the choice', () => {
    const { cursorPhoto, vc } = setup('landscape')
    vc.setCounterpart(photo(2, 'portrait'))
    vc.toggle()
    expect(cursorPhoto.value?.id).toBe(2)
    expect(vc.variantPhoto.value?.id).toBe(1)
    expect(vc.pinned.value).toBe(true)
  })

  it('follows the screen when it turns, but not against a pinned choice', async () => {
    const { screenRef, cursorPhoto, vc } = setup('landscape')
    vc.setCounterpart(photo(2, 'portrait'))

    screenRef.value = 'portrait'
    await nextTick()
    expect(cursorPhoto.value?.id).toBe(2)
    expect(vc.pinned.value).toBe(false)

    // Turn back: the landscape frame fits again.
    screenRef.value = 'landscape'
    await nextTick()
    expect(cursorPhoto.value?.id).toBe(1)

    // The user picks the portrait frame on a landscape screen; turning the
    // device to portrait and back must leave that choice alone.
    vc.toggle()
    expect(cursorPhoto.value?.id).toBe(2)
    screenRef.value = 'portrait'
    await nextTick()
    screenRef.value = 'landscape'
    await nextTick()
    expect(cursorPhoto.value?.id).toBe(2)
  })

  it('does nothing without a counterpart and forgets the pin on reset', async () => {
    const { screenRef, cursorPhoto, vc } = setup('landscape')
    vc.toggle()
    expect(cursorPhoto.value?.id).toBe(1)
    screenRef.value = 'portrait'
    await nextTick()
    expect(cursorPhoto.value?.id).toBe(1)

    vc.setCounterpart(photo(2, 'portrait'))
    vc.toggle()
    vc.reset()
    expect(vc.variantPhoto.value).toBeNull()
    expect(vc.pinned.value).toBe(false)
  })
})
