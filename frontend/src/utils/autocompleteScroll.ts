/**
 * Scroll the selected entry of an opened PrimeVue `AutoComplete` list into
 * view.
 *
 * `AutoComplete` with `dropdown` opens its list at the top, whatever is
 * selected: it marks the current value (`data-p-selected`) but only scrolls
 * when the keyboard moves the focused option. With a long list, such as the
 * three-level category taxonomy, the user then hunts for the value that is
 * already set. Bind this to the component's `show` event, which fires once
 * the overlay is in the DOM:
 *
 *   <AutoComplete ref="picker" … @show="scrollSelectedOptionIntoView(picker)" />
 *
 * The overlay element is the instance's `overlay` field (PrimeVue stores
 * the teleported panel there); a closed or empty list is a no-op.
 */
export function scrollSelectedOptionIntoView(instance: unknown): void {
  const overlay = (instance as { overlay?: HTMLElement | null } | null)?.overlay
  if (!overlay) return
  const selected = overlay.querySelector<HTMLElement>('li[data-p-selected="true"]')
  selected?.scrollIntoView?.({ block: 'center' })
}
