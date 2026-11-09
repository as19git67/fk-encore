/**
 * Whether the module's sub-menu fits into the navbar's own line.
 *
 * On a wide screen the navbar is mostly empty between the module name and
 * the meta icons, while the sub-menu takes a line of its own below it. From
 * `xl` on the sub-menu moves up into that gap — but only when all of it fits
 * at its natural width: a module with many entries (Finanzen) keeps its own
 * row rather than scrolling sideways inside the navbar.
 *
 * All widths in CSS pixels. `content` is the sub-menu's natural width (its
 * entries side by side plus the action buttons), measured independently of
 * where it currently sits, so the answer does not flip back and forth when
 * the menu moves.
 */
export interface NavbarWidths {
  /** Inner width of the navbar (without its padding). */
  navbar: number
  /** Hamburger + module name. */
  start: number
  /** Assistant, basket, settings, sign-out. */
  end: number
  /** The sub-menu at its natural width. */
  content: number
}

/** Room kept between the sub-menu and its neighbours on either side. */
export const NAVBAR_SUBMENU_GAP = 16

export function submenuFitsNavbar(w: NavbarWidths): boolean {
  if (w.content <= 0 || w.navbar <= 0) return false
  return w.start + w.end + w.content + 2 * NAVBAR_SUBMENU_GAP <= w.navbar
}
