/**
 * The collage layouts, without dependencies: the same table as the collage
 * dialog's (`frontend/src/utils/collageLayouts.ts`), same ids and cells, so
 * the assistant's card previews exactly what `photo/collage.ts` renders.
 * `frontend/src/utils/collageLayouts.server.test.ts` holds the two equal.
 */

export interface CollageCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CollageLayout {
  id: string;
  name: string;
  /** Width / height. */
  aspect: number;
  cells: CollageCell[];
}

const FULL: CollageCell = { x: 0, y: 0, w: 1, h: 1 };

function cell(x: number, y: number, w: number, h: number): CollageCell {
  return { x, y, w, h };
}

function gridCells(cols: number, rows: number, region: CollageCell = FULL): CollageCell[] {
  const cw = region.w / cols;
  const ch = region.h / rows;
  const out: CollageCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch));
  }
  return out;
}

function rowBands(counts: number[], region: CollageCell = FULL): CollageCell[] {
  const ch = region.h / counts.length;
  const out: CollageCell[] = [];
  counts.forEach((n, r) => {
    const cw = region.w / n;
    for (let c = 0; c < n; c++) out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch));
  });
  return out;
}

function colBands(counts: number[], region: CollageCell = FULL): CollageCell[] {
  const cw = region.w / counts.length;
  const out: CollageCell[] = [];
  counts.forEach((n, c) => {
    const ch = region.h / n;
    for (let r = 0; r < n; r++) out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch));
  });
  return out;
}

function heroLeft(heroW: number, restRows: number[]): CollageCell[] {
  return [cell(0, 0, heroW, 1), ...rowBands(restRows, { x: heroW, y: 0, w: 1 - heroW, h: 1 })];
}

const LAYOUTS: Record<number, CollageLayout[]> = {
  2: [
    { id: "side", name: "Nebeneinander", aspect: 3 / 2, cells: rowBands([2]) },
    { id: "stack", name: "Übereinander", aspect: 3 / 4, cells: colBands([2]) },
    { id: "big-left", name: "Groß + Klein", aspect: 3 / 2, cells: [cell(0, 0, 0.62, 1), cell(0.62, 0, 0.38, 1)] },
  ],
  3: [
    { id: "cols", name: "Spalten", aspect: 3 / 2, cells: rowBands([3]) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: heroLeft(0.6, [1, 1]) },
    { id: "hero-top", name: "Held oben", aspect: 1, cells: [cell(0, 0, 1, 0.6), cell(0, 0.6, 0.5, 0.4), cell(0.5, 0.6, 0.5, 0.4)] },
  ],
  4: [
    { id: "grid", name: "Raster 2×2", aspect: 1, cells: gridCells(2, 2) },
    { id: "cols", name: "Spalten", aspect: 16 / 9, cells: rowBands([4]) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: heroLeft(0.6, [1, 1, 1]) },
  ],
  5: [
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: [cell(0, 0, 0.6, 1), ...gridCells(2, 2, { x: 0.6, y: 0, w: 0.4, h: 1 })] },
    { id: "two-three", name: "2 / 3", aspect: 3 / 2, cells: rowBands([2, 3]) },
    { id: "three-two", name: "3 / 2", aspect: 3 / 2, cells: rowBands([3, 2]) },
  ],
  6: [
    { id: "grid-3x2", name: "Raster 3×2", aspect: 3 / 2, cells: gridCells(3, 2) },
    { id: "grid-2x3", name: "Raster 2×3", aspect: 2 / 3, cells: gridCells(2, 3) },
    { id: "two-four", name: "2 groß / 4", aspect: 3 / 2, cells: rowBands([2, 4]) },
  ],
  7: [
    { id: "three-four", name: "3 / 4", aspect: 3 / 2, cells: rowBands([3, 4]) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: [cell(0, 0, 0.5, 1), ...gridCells(2, 3, { x: 0.5, y: 0, w: 0.5, h: 1 })] },
    { id: "four-three", name: "4 / 3", aspect: 3 / 2, cells: rowBands([4, 3]) },
  ],
  8: [
    { id: "grid-4x2", name: "Raster 4×2", aspect: 16 / 9, cells: gridCells(4, 2) },
    { id: "grid-2x4", name: "Raster 2×4", aspect: 9 / 16, cells: gridCells(2, 4) },
    { id: "three-two-three", name: "3 / 2 / 3", aspect: 1, cells: rowBands([3, 2, 3]) },
  ],
  9: [
    { id: "grid-3x3", name: "Raster 3×3", aspect: 1, cells: gridCells(3, 3) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: [cell(0, 0, 0.5, 1), ...gridCells(2, 4, { x: 0.5, y: 0, w: 0.5, h: 1 })] },
    { id: "two-three-four", name: "2 / 3 / 4", aspect: 3 / 2, cells: rowBands([2, 3, 4]) },
  ],
};

export const MIN_COLLAGE_PHOTOS = 2;
export const MAX_COLLAGE_PHOTOS = 9;

export function collageLayouts(count: number): CollageLayout[] {
  return LAYOUTS[count] ?? [];
}

/** The layout `id` for `count` photos, the first variant when none is named; undefined for an unknown id. */
export function pickCollageLayout(count: number, id?: string | null): CollageLayout | undefined {
  const all = collageLayouts(count);
  return id ? all.find((l) => l.id === id) : all[0];
}
