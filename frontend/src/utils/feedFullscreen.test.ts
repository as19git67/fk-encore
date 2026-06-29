import { describe, expect, it } from 'vitest'
import {
  clampFeedZoom,
  feedPinchZoom,
  isFeedFullscreenTap,
  shouldUseNativeFeedFullscreen,
} from './feedFullscreen'

describe('feed fullscreen gestures', () => {
  it('clamps pinch zoom to the supported range', () => {
    expect(feedPinchZoom(1, 100, 250)).toBe(2.5)
    expect(feedPinchZoom(4, 100, 200)).toBe(5)
    expect(feedPinchZoom(2, 100, 10)).toBe(1)
    expect(clampFeedZoom(Number.NaN)).toBe(1)
  })

  it('only treats a stationary non-pinch gesture as close tap', () => {
    expect(isFeedFullscreenTap(3, 4, false)).toBe(true)
    expect(isFeedFullscreenTap(20, 0, false)).toBe(false)
    expect(isFeedFullscreenTap(0, 0, true)).toBe(false)
  })

  it('uses native fullscreen only for desktop-like pointers', () => {
    expect(shouldUseNativeFeedFullscreen(() => true)).toBe(true)
    expect(shouldUseNativeFeedFullscreen(() => false)).toBe(false)
  })
})
