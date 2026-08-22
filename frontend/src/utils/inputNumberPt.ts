/**
 * Workaround for a PrimeVue InputNumber quirk: it sets the underlying
 * `<input inputmode>` to "numeric" (digits-only virtual keyboard, no comma/
 * period key) whenever `minFractionDigits` is falsy — regardless of
 * `maxFractionDigits`. A field that *allows* decimals but doesn't *require*
 * a trailing zero (`min-fraction-digits="0"`, `max-fraction-digits="3"`,
 * e.g. a meter reading or a price) hits this and becomes impossible to
 * enter a decimal value into on a phone's numeric keypad.
 *
 * Apply via `:pt="decimalInputPt"` on any InputNumber that allows decimals
 * with min-fraction-digits="0".
 */
export const decimalInputPt = {
  pcInputText: {
    root: { inputmode: 'decimal' },
  },
}
