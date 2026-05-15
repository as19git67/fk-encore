// Tests for the Phase 4b client-side display helpers. Pure functions
// only — no DOM, no Vue, no DB. The output strings are checked for
// numeric correctness; visual rendering is the editor component's
// responsibility and is covered by Storybook / e2e tests later.

import { describe, it, expect } from 'vitest';
import {
  buildRecipeSvgFilter,
  cropImageStyle,
  cropToPixels,
  recipeNeedsSvgFilter,
  recipeToCssFilter,
  recipeToCssTransform,
} from './photoTransformRecipe';

describe('recipeNeedsSvgFilter', () => {
  it('returns false for a neutral recipe', () => {
    expect(recipeNeedsSvgFilter({})).toBe(false);
    expect(
      recipeNeedsSvgFilter({ exposure: 1, contrast: 0.5, gamma: 1 }),
    ).toBe(false);
  });
  it('returns true when gamma differs from 1', () => {
    expect(recipeNeedsSvgFilter({ gamma: 1.5 })).toBe(true);
  });
  it('returns true when a black or white point is set', () => {
    expect(recipeNeedsSvgFilter({ black_point: 0.1 })).toBe(true);
    expect(recipeNeedsSvgFilter({ white_point: 0.9 })).toBe(true);
  });
  it('treats explicit neutral bp/wp as no-op', () => {
    expect(
      recipeNeedsSvgFilter({ black_point: 0, white_point: 1, gamma: 1 }),
    ).toBe(false);
  });
});

describe('recipeToCssFilter', () => {
  it('returns the empty string for a neutral recipe', () => {
    expect(recipeToCssFilter({})).toBe('');
  });

  it('emits brightness(1) → omitted but exposure=1 → brightness(2)', () => {
    expect(recipeToCssFilter({ exposure: 1 })).toBe('brightness(2.0000)');
    expect(recipeToCssFilter({ exposure: -1 })).toBe('brightness(0.5000)');
  });

  it('emits contrast multiplier as (1 + c)', () => {
    expect(recipeToCssFilter({ contrast: 0.2 })).toBe('contrast(1.2000)');
    expect(recipeToCssFilter({ contrast: -0.5 })).toBe('contrast(0.5000)');
  });

  it('combines exposure and contrast in one string', () => {
    expect(recipeToCssFilter({ exposure: 0.5, contrast: 0.1 })).toBe(
      'brightness(1.4142) contrast(1.1000)',
    );
  });

  it('appends url(#id) only when gamma or bp/wp require SVG and an id is given', () => {
    expect(recipeToCssFilter({ gamma: 1.5 }, 'rec-7')).toBe('url(#rec-7)');
    expect(recipeToCssFilter({ exposure: 0.3, gamma: 1.5 }, 'rec-7')).toBe(
      'brightness(1.2311) url(#rec-7)',
    );
    expect(recipeToCssFilter({ gamma: 1.5 })).toBe(''); // no id → no url()
  });
});

describe('recipeToCssTransform', () => {
  it('returns empty for rotation 0 / undefined', () => {
    expect(recipeToCssTransform({})).toBe('');
    expect(recipeToCssTransform({ rotation: 0 })).toBe('');
  });
  it('emits a rotate() for non-zero rotation', () => {
    expect(recipeToCssTransform({ rotation: 90 })).toBe('rotate(90deg)');
    expect(recipeToCssTransform({ rotation: 270 })).toBe('rotate(270deg)');
  });
});

describe('buildRecipeSvgFilter', () => {
  it('returns empty when no SVG-only ops are needed', () => {
    expect(buildRecipeSvgFilter('x', { exposure: 1 })).toBe('');
  });

  it('emits feFuncR/G/B gamma when gamma differs from 1', () => {
    const out = buildRecipeSvgFilter('rec-1', { gamma: 2 });
    expect(out).toContain('<filter id="rec-1"');
    expect(out).toContain('feComponentTransfer');
    expect(out).toContain('type="gamma"');
    // exponent = 1/2 = 0.5
    expect(out).toContain('exponent="0.500000"');
    expect(out).toContain('feFuncR');
    expect(out).toContain('feFuncG');
    expect(out).toContain('feFuncB');
  });

  it('emits feFuncR/G/B linear when bp/wp are set', () => {
    const out = buildRecipeSvgFilter('rec-2', { black_point: 0.1, white_point: 0.9 });
    // slope = 1/(0.9 - 0.1) = 1.25
    expect(out).toContain('slope="1.250000"');
    // intercept = -0.1 * 1.25 = -0.125
    expect(out).toContain('intercept="-0.125000"');
    expect(out).toContain('type="linear"');
  });

  it('chains linear → gamma when both are present', () => {
    const out = buildRecipeSvgFilter('rec-3', {
      gamma: 1.4,
      black_point: 0.05,
      white_point: 0.95,
    });
    // First feComponentTransfer outputs to "linearOut", second consumes it.
    expect(out).toMatch(/result="linearOut"/);
    expect(out).toMatch(/in="linearOut"/);
    // The two transfer blocks must appear in this order.
    const linearIdx = out.indexOf('type="linear"');
    const gammaIdx = out.indexOf('type="gamma"');
    expect(linearIdx).toBeGreaterThan(-1);
    expect(gammaIdx).toBeGreaterThan(-1);
    expect(linearIdx).toBeLessThan(gammaIdx);
  });
});

describe('cropImageStyle', () => {
  it('returns null when no crop or full-frame crop is given', () => {
    expect(cropImageStyle(undefined)).toBeNull();
    expect(cropImageStyle(null)).toBeNull();
    expect(cropImageStyle({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it('sizes the image so its cropped region fills 100% of the container', () => {
    const s = cropImageStyle({ x: 0.25, y: 0, w: 0.5, h: 1 })!;
    expect(s.width).toBe('200%'); // 100 / 0.5
    expect(s.height).toBe('100%'); // 100 / 1
    expect(s.transform).toBe('translate(-50%, 0%)');
    expect(s.position).toBe('absolute');
  });

  it('translates by the crop offset', () => {
    const s = cropImageStyle({ x: 0.1, y: 0.2, w: 0.4, h: 0.5 })!;
    // 100/0.4 = 250%
    expect(s.width).toBe('250%');
    expect(s.height).toBe('200%');
    // translate(-0.1/0.4*100 %, -0.2/0.5*100 %) = (-25%, -40%)
    expect(s.transform).toBe('translate(-25%, -40%)');
  });

  it('overrides max-width so the oversized image is not Tailwind-clipped', () => {
    const s = cropImageStyle({ x: 0, y: 0, w: 0.5, h: 0.5 })!;
    expect(s.maxWidth).toBe('none');
  });
});

describe('cropToPixels', () => {
  it('rounds normalised coords to pixel ints', () => {
    expect(cropToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1000, 800)).toEqual({
      left: 250,
      top: 400,
      width: 500,
      height: 200,
    });
  });
});
