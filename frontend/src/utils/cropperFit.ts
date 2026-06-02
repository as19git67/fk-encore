// Geometry helpers for the crop overlay (PhotoCropper).
//
// The cropper shows the image with `object-fit: contain` inside a wrapper
// element. When the wrapper's aspect ratio doesn't match the image's, the
// image is letterboxed (top/bottom) or pillarboxed (left/right) inside the
// wrapper. The crop rectangle is stored in *image* coordinates (0..1), so to
// position the overlay correctly we must map image coords → wrapper coords via
// the contained image's rectangle — otherwise a full-width crop on a portrait
// image spills into the side bars.

export interface ContainFit {
  /** Left offset of the rendered image inside the wrapper, as a fraction. */
  ox: number
  /** Top offset of the rendered image inside the wrapper, as a fraction. */
  oy: number
  /** Width of the rendered image, as a fraction of the wrapper width. */
  ow: number
  /** Height of the rendered image, as a fraction of the wrapper height. */
  oh: number
}

/**
 * Where the `object-fit: contain` image sits inside its wrapper, expressed as
 * fractions of the wrapper box. When the wrapper already matches the image
 * aspect, this is the identity {0,0,1,1}.
 */
export function containFit(
  wrapperW: number,
  wrapperH: number,
  imageAspect: number,
): ContainFit {
  if (!(wrapperW > 0) || !(wrapperH > 0) || !(imageAspect > 0)) {
    return { ox: 0, oy: 0, ow: 1, oh: 1 }
  }
  const wrapperAspect = wrapperW / wrapperH
  if (imageAspect > wrapperAspect) {
    // Image is wider than the wrapper → full width, letterboxed top/bottom.
    const oh = wrapperAspect / imageAspect
    return { ox: 0, oy: (1 - oh) / 2, ow: 1, oh }
  }
  // Image is taller than (or equal to) the wrapper → full height, pillarboxed.
  const ow = imageAspect / wrapperAspect
  return { ox: (1 - ow) / 2, oy: 0, ow, oh: 1 }
}

export interface RectFrac {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Map a crop rectangle (image coords, 0..1) into wrapper-fraction coords using
 * the contained-image fit, so the overlay lines up with the visible image.
 */
export function cropToWrapper(
  crop: { x: number; y: number; w: number; h: number },
  fit: ContainFit,
): RectFrac {
  return {
    left: fit.ox + crop.x * fit.ow,
    top: fit.oy + crop.y * fit.oh,
    width: crop.w * fit.ow,
    height: crop.h * fit.oh,
  }
}
