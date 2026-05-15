// Photo transformations — Phase 4b: client-side display helpers.
//
// All four building blocks needed to render a recipe in the browser
// without a server round-trip:
//
//   1. recipeToCssFilter(recipe, svgFilterId?)
//        → "brightness(…) contrast(…) [url(#id)]"
//   2. recipeNeedsSvgFilter(recipe)
//        → true if gamma / black-point / white-point require SVG.
//   3. buildRecipeSvgFilter(filterId, recipe)
//        → "<filter id=…><feComponentTransfer>…</feComponentTransfer></filter>"
//      Embed in a global <svg> defs block.
//   4. cropImageStyle(crop)
//        → CSS that, applied to an <img> inside an overflow:hidden
//          container with the crop's aspect ratio, displays only the
//          cropped region of the original.
//
// Together they let the editor and detail views render a transformed
// photo from the original URL — no /photos/:id/render call needed for
// live preview or the user's own recipe.

export interface PhotoTransformCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoTransformRecipe {
  crop?: PhotoTransformCrop | null;
  rotation?: number;
  exposure?: number;
  contrast?: number;
  gamma?: number;
  white_point?: number | null;
  black_point?: number | null;
}

const EPS = 1e-6;

function approxEq(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) < eps;
}

/**
 * True if any of gamma / black_point / white_point deviate from their
 * neutral values. The CSS `filter` shorthand can't express these, so the
 * caller needs to render an SVG <filter> alongside and reference it.
 */
export function recipeNeedsSvgFilter(recipe: PhotoTransformRecipe): boolean {
  if (recipe.gamma !== undefined && recipe.gamma !== null && !approxEq(recipe.gamma, 1)) {
    return true;
  }
  if (recipe.black_point != null && !approxEq(recipe.black_point, 0)) return true;
  if (recipe.white_point != null && !approxEq(recipe.white_point, 1)) return true;
  return false;
}

/**
 * CSS `filter` value combining exposure and contrast (via the built-in
 * brightness()/contrast() filters) plus, if needed, a reference to an
 * SVG filter that handles gamma / bp / wp. Returns an empty string when
 * nothing needs to be applied.
 *
 *   filter: brightness(1.414) contrast(1.10) url(#photo-recipe-42)
 *
 * Exposure is converted to a brightness multiplier: 2^EV.
 */
export function recipeToCssFilter(
  recipe: PhotoTransformRecipe,
  svgFilterId?: string,
): string {
  const parts: string[] = [];
  const exp = recipe.exposure ?? 0;
  if (!approxEq(exp, 0)) {
    parts.push(`brightness(${(Math.pow(2, exp)).toFixed(4)})`);
  }
  const c = recipe.contrast ?? 0;
  if (!approxEq(c, 0)) {
    parts.push(`contrast(${(1 + c).toFixed(4)})`);
  }
  if (svgFilterId && recipeNeedsSvgFilter(recipe)) {
    parts.push(`url(#${svgFilterId})`);
  }
  return parts.join(" ");
}

/**
 * CSS `transform` value for the recipe's rotation. Returns an empty
 * string for rotation = 0 / undefined.
 */
export function recipeToCssTransform(recipe: PhotoTransformRecipe): string {
  const r = recipe.rotation ?? 0;
  if (!r) return "";
  return `rotate(${r}deg)`;
}

/**
 * Returns an SVG filter element (as a string of innerHTML) that encodes
 * gamma + black-point/white-point as feComponentTransfer entries.
 * Caller is responsible for placing it inside a global <svg> (typically
 * an off-screen <svg width="0" height="0"> in the root layout).
 *
 *   <svg width="0" height="0">
 *     <defs v-html="buildRecipeSvgFilter(id, recipe)"></defs>
 *   </svg>
 *
 * Returns an empty string when no SVG-only ops are needed.
 */
export function buildRecipeSvgFilter(
  filterId: string,
  recipe: PhotoTransformRecipe,
): string {
  if (!recipeNeedsSvgFilter(recipe)) return "";

  // Black/white-point → linear remap on [0, 1] sRGB-encoded values.
  // output = (input - bp) / (wp - bp)
  // feFuncR linear: output = slope*input + intercept
  const bp = recipe.black_point ?? 0;
  const wp = recipe.white_point ?? 1;
  const linearOps: string[] = [];
  if (!approxEq(bp, 0) || !approxEq(wp, 1)) {
    const slope = 1 / Math.max(wp - bp, 1e-3);
    const intercept = -bp * slope;
    linearOps.push(
      `<feFuncR type="linear" slope="${slope.toFixed(6)}" intercept="${intercept.toFixed(6)}"/>`,
      `<feFuncG type="linear" slope="${slope.toFixed(6)}" intercept="${intercept.toFixed(6)}"/>`,
      `<feFuncB type="linear" slope="${slope.toFixed(6)}" intercept="${intercept.toFixed(6)}"/>`,
    );
  }

  // Gamma → feFuncR/G/B type="gamma" with exponent = 1/gamma.
  const gammaOps: string[] = [];
  const g = recipe.gamma ?? 1;
  if (!approxEq(g, 1)) {
    const exponent = 1 / Math.max(g, 0.01);
    gammaOps.push(
      `<feFuncR type="gamma" amplitude="1" exponent="${exponent.toFixed(6)}" offset="0"/>`,
      `<feFuncG type="gamma" amplitude="1" exponent="${exponent.toFixed(6)}" offset="0"/>`,
      `<feFuncB type="gamma" amplitude="1" exponent="${exponent.toFixed(6)}" offset="0"/>`,
    );
  }

  // Apply linear remap first (sets the dynamic range), then gamma. Two
  // feComponentTransfer entries keep the math obvious.
  let body = "";
  if (linearOps.length > 0) {
    body += `<feComponentTransfer in="SourceGraphic" result="linearOut">${linearOps.join("")}</feComponentTransfer>`;
  }
  if (gammaOps.length > 0) {
    const inAttr = linearOps.length > 0 ? ` in="linearOut"` : "";
    body += `<feComponentTransfer${inAttr}>${gammaOps.join("")}</feComponentTransfer>`;
  }

  return `<filter id="${filterId}" color-interpolation-filters="sRGB">${body}</filter>`;
}

/**
 * CSS that, when applied to an <img> placed inside a container with
 * `position: relative; overflow: hidden;` and the crop's aspect ratio,
 * displays only the cropped region of the source image.
 *
 * Layout assumption:
 *   <div style="position: relative; aspect-ratio: …; overflow: hidden;">
 *     <img :style="cropImageStyle(crop)" src="…original…">
 *   </div>
 *
 * Returns null when crop is null/undefined or a full-frame [0,0,1,1]
 * crop — the caller can just render the original <img> as-is.
 */
export function cropImageStyle(
  crop: PhotoTransformCrop | null | undefined,
): Record<string, string> | null {
  if (!crop) return null;
  // A full-frame crop is a no-op; let the caller render the bare <img>.
  if (
    approxEq(crop.x, 0) &&
    approxEq(crop.y, 0) &&
    approxEq(crop.w, 1) &&
    approxEq(crop.h, 1)
  ) {
    return null;
  }
  const w = Math.max(crop.w, 1e-6);
  const h = Math.max(crop.h, 1e-6);
  // Percent translations are relative to the element's own size — exactly
  // what we want: at width=100%/w, translateX(-x/w*100%) shifts by
  // (-x/w) * (container.width/w) = -x*container.width/w*… etc.
  return {
    width: `${100 / w}%`,
    height: `${100 / h}%`,
    transform: `translate(${(-crop.x / w) * 100}%, ${(-crop.y / h) * 100}%)`,
    transformOrigin: "0 0",
    position: "absolute",
    top: "0",
    left: "0",
    maxWidth: "none", // override Tailwind's img-max-width:100% reset
  };
}

/**
 * Compute the pixel-space rectangle for a normalised crop, given the
 * intrinsic image dimensions. Used by rule-of-thirds overlays and the
 * cropper handle math.
 */
export function cropToPixels(
  crop: PhotoTransformCrop,
  naturalWidth: number,
  naturalHeight: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.round(crop.x * naturalWidth),
    top: Math.round(crop.y * naturalHeight),
    width: Math.round(crop.w * naturalWidth),
    height: Math.round(crop.h * naturalHeight),
  };
}
