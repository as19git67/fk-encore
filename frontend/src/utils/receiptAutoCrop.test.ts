import { describe, expect, it } from 'vitest'
import { detectDocumentBounds } from './receiptOcr'

function makePixelData(width: number, height: number, fill: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill
    data[i + 1] = fill
    data[i + 2] = fill
    data[i + 3] = 255
  }
  return data
}

function drawRect(
  data: Uint8ClampedArray,
  width: number,
  x1: number, y1: number, x2: number, y2: number,
  color: number,
): void {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const i = (y * width + x) * 4
      data[i] = color
      data[i + 1] = color
      data[i + 2] = color
    }
  }
}

describe('detectDocumentBounds', () => {
  it('returns null for images too small', () => {
    const data = makePixelData(50, 50, 128)
    expect(detectDocumentBounds(50, 50, data)).toBeNull()
  })

  it('returns null for a uniform image (no edges)', () => {
    const data = makePixelData(200, 300, 128)
    expect(detectDocumentBounds(200, 300, data)).toBeNull()
  })

  it('detects a white receipt on a dark background', () => {
    const width = 400
    const height = 600
    const data = makePixelData(width, height, 40) // dark background
    drawRect(data, width, 60, 80, 340, 520, 240) // white receipt
    const bounds = detectDocumentBounds(width, height, data)
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeLessThanOrEqual(65)
    expect(bounds!.y).toBeLessThanOrEqual(85)
    expect(bounds!.x + bounds!.w).toBeGreaterThanOrEqual(335)
    expect(bounds!.y + bounds!.h).toBeGreaterThanOrEqual(515)
  })

  it('returns null when the receipt fills the entire frame', () => {
    const width = 400
    const height = 600
    const data = makePixelData(width, height, 240) // all white
    drawRect(data, width, 0, 0, width - 1, 2, 40) // tiny edge at top
    drawRect(data, width, 0, height - 3, width - 1, height - 1, 40) // tiny edge at bottom
    const bounds = detectDocumentBounds(width, height, data)
    expect(bounds).toBeNull()
  })

  it('returns null if the crop would be too aggressive', () => {
    const width = 400
    const height = 600
    const data = makePixelData(width, height, 40)
    drawRect(data, width, 180, 270, 220, 330, 240) // tiny receipt
    const bounds = detectDocumentBounds(width, height, data)
    expect(bounds).toBeNull()
  })
})
