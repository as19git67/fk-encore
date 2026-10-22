import { describe, it, expect } from 'vitest'
import { collageLayouts } from './collageLayouts'
// The server's copy, which renders the assistant's collages (dependency-free).
import { collageLayouts as serverLayouts } from '../../../photo/collage-layouts'

describe('collage layouts on the server', () => {
  it('are the dialog layouts, so the assistant card previews what the server renders', () => {
    for (let n = 1; n <= 10; n++) {
      expect(serverLayouts(n)).toEqual(collageLayouts(n))
    }
  })
})
