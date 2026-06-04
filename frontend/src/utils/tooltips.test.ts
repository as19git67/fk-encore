import { describe, it, expect } from 'vitest'
import { deviceSupportsHoverTooltips, TOOLTIP_CAPABLE_QUERY } from './tooltips'

describe('deviceSupportsHoverTooltips', () => {
  it('enables tooltips when the device can hover with a fine pointer (desktop)', () => {
    expect(deviceSupportsHoverTooltips(() => true)).toBe(true)
  })

  it('disables tooltips on a touch / hover-less device (phone, iOS)', () => {
    // The double-tap bug: such devices treat the first tap as a hover.
    expect(deviceSupportsHoverTooltips(() => false)).toBe(false)
  })

  it('queries the hover + fine-pointer media feature', () => {
    let asked = ''
    deviceSupportsHoverTooltips((q) => { asked = q; return true })
    expect(asked).toBe(TOOLTIP_CAPABLE_QUERY)
    expect(TOOLTIP_CAPABLE_QUERY).toContain('hover: hover')
    expect(TOOLTIP_CAPABLE_QUERY).toContain('pointer: fine')
  })
})
