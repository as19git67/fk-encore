import type { PageRect } from '../api/photoBooks'

/**
 * Where the image of a photo-book slot sits in its frame, as shares of the
 * frame (x/y may be negative: the frame clips).
 *
 * `window` is the part of the photo the server wants shown, `frameAspect`
 * the frame's width / height on the page, `imageAspect` the image's own
 * width / height once loaded (null before). The server reckons with the size
 * it has on record; when the image is shaped differently, fitting it to the
 * window on both axes would stretch it. So the image keeps its own aspect,
 * covers the frame, and puts the window's centre in the frame's centre as
 * far as the photo reaches. With the server's aspect this is the window exactly.
 */
export function slotImageBox(window: PageRect, frameAspect: number, imageAspect: number | null): PageRect {
  const eps = 1e-9
  const serverAspect = (frameAspect * window.h) / Math.max(eps, window.w)
  const aspect = imageAspect && imageAspect > 0 ? imageAspect : serverAspect
  const w = Math.max(1 / Math.max(eps, window.w), aspect / Math.max(eps, frameAspect * window.h))
  const h = (w * frameAspect) / aspect
  const clamp = (v: number, size: number) => Math.min(0, Math.max(1 - size, v))
  return {
    x: clamp(0.5 - (window.x + window.w / 2) * w, w),
    y: clamp(0.5 - (window.y + window.h / 2) * h, h),
    w,
    h,
  }
}
