import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'

/**
 * Reordering a vertical list by dragging a grip, with mouse, finger or pen.
 *
 * Built on pointer events rather than the HTML5 drag-and-drop API: that API
 * never fires for a finger on iOS Safari and draws its own ghost image we
 * cannot style. Here the row itself follows the pointer and the rows it
 * passes slide out of its way, so what you see on release is what gets saved.
 *
 * Nothing moves in the DOM while dragging — only `transform`s (`rowStyle`).
 * Re-sorting the keyed rows mid-drag would detach and re-insert the grip's
 * row, which drops the pointer capture and, on iOS, cancels the touch: the
 * release then never arrives and the drag never ends. The list is re-sorted
 * once, on release.
 *
 * The grip doubles as the keyboard handle: ArrowUp/ArrowDown on the focused
 * grip move the row by one, so dragging is never the only way to reorder.
 *
 * Rows are found through the DOM: the list carries `data-reorder-list`, every
 * row `data-reorder-key="<key>"`. They are measured once, at the start, in
 * page coordinates, so auto-scrolling the page does not throw the target off.
 */

export type ReorderKey = string | number

export interface UseDragReorderOptions<T> {
  items: Ref<T[]> | ComputedRef<T[]>
  keyOf: (item: T) => ReorderKey
  /** Persist the new order. The preview order is held until it settles. */
  commit: (keys: ReorderKey[]) => Promise<void> | void
  disabled?: Ref<boolean> | ComputedRef<boolean>
}

export interface UseDragReorderReturn<T> {
  /** The items in the order to render — the preview while dragging. */
  ordered: ComputedRef<T[]>
  /** Key of the row being dragged, or null. */
  draggingKey: Ref<ReorderKey | null>
  /** Inline style for a row: its offset while a drag is under way. */
  rowStyle: (key: ReorderKey) => Record<string, string> | undefined
  onGripPointerDown: (key: ReorderKey, event: PointerEvent) => void
  onGripKeydown: (key: ReorderKey, event: KeyboardEvent) => void
}

/**
 * Where a row dragged to `pointerY` lands among the *other* rows, given their
 * vertical midpoints in display order: one past every row whose middle the
 * pointer has passed.
 */
export function reorderTargetIndex(otherMidpoints: number[], pointerY: number): number {
  let index = 0
  for (const mid of otherMidpoints) {
    if (pointerY > mid) index++
  }
  return index
}

/** `keys` with `key` moved to `to` (an index into the result). */
export function moveKey(keys: ReorderKey[], key: ReorderKey, to: number): ReorderKey[] {
  const rest = keys.filter((k) => k !== key)
  if (rest.length === keys.length) return keys
  const clamped = Math.max(0, Math.min(to, rest.length))
  return [...rest.slice(0, clamped), key, ...rest.slice(clamped)]
}

function sameOrder(a: ReorderKey[], b: ReorderKey[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/** Distance from the viewport edge at which the page starts scrolling. */
const AUTOSCROLL_EDGE = 64
const AUTOSCROLL_MAX_STEP = 14

export function useDragReorder<T>(options: UseDragReorderOptions<T>): UseDragReorderReturn<T> {
  const { items, keyOf, commit, disabled } = options

  /** Order shown while dragging and until the saved order comes back. */
  const preview = ref<ReorderKey[] | null>(null)
  const draggingKey = ref<ReorderKey | null>(null)

  const savedKeys = computed(() => items.value.map(keyOf))

  // The server answered with a (possibly different) order: that one wins.
  watch(savedKeys, () => {
    if (draggingKey.value === null) preview.value = null
  })

  const ordered = computed<T[]>(() => {
    const keys = preview.value
    if (!keys) return items.value
    const byKey = new Map(items.value.map((item) => [keyOf(item), item]))
    const out = keys.map((k) => byKey.get(k)).filter((item): item is T => item !== undefined)
    // A row that appeared meanwhile (realtime, rule) is not lost.
    for (const item of items.value) if (!keys.includes(keyOf(item))) out.push(item)
    return out
  })

  /** Geometry captured at the start of a drag, in page coordinates. */
  interface DragState {
    key: ReorderKey
    pointerId: number
    keys: ReorderKey[]
    from: number
    /** Vertical middle of every row, in `keys` order. */
    mids: number[]
    /** How far the other rows move to make room: row height plus gap. */
    slot: number
    startPageY: number
  }
  let drag: DragState | null = null
  /** How far the dragged row has travelled, and where it would land. */
  const offset = ref(0)
  const target = ref(0)
  let lastClientY = 0
  let rafId = 0

  async function finish(keys: ReorderKey[]) {
    if (sameOrder(keys, savedKeys.value)) {
      preview.value = null
      return
    }
    try {
      await commit(keys)
    } catch {
      // Reporting a failed save is the caller's; the list just snaps back.
    } finally {
      // Whatever came back (or nothing, on error) is the truth now.
      preview.value = null
    }
  }

  function update() {
    if (!drag) return
    offset.value = lastClientY + window.scrollY - drag.startPageY
    const center = drag.mids[drag.from]! + offset.value
    target.value = reorderTargetIndex(
      drag.mids.filter((_, i) => i !== drag!.from),
      center,
    )
  }

  function rowStyle(key: ReorderKey): Record<string, string> | undefined {
    if (!drag || draggingKey.value === null) return undefined
    if (key === drag.key) {
      return { transform: `translateY(${offset.value}px)`, transition: 'none' }
    }
    const i = drag.keys.indexOf(key)
    let shift = 0
    if (i > drag.from && i <= target.value) shift = -drag.slot
    else if (i < drag.from && i >= target.value) shift = drag.slot
    return { transform: `translateY(${shift}px)`, transition: 'transform 150ms ease' }
  }

  function autoscroll() {
    rafId = 0
    if (!drag) return
    const h = window.innerHeight
    let step = 0
    if (lastClientY < AUTOSCROLL_EDGE)
      step = -Math.ceil(((AUTOSCROLL_EDGE - lastClientY) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX_STEP)
    else if (lastClientY > h - AUTOSCROLL_EDGE)
      step = Math.ceil(((lastClientY - (h - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX_STEP)
    if (step !== 0) {
      window.scrollBy(0, step)
      update()
    }
    rafId = requestAnimationFrame(autoscroll)
  }

  function onMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    event.preventDefault()
    lastClientY = event.clientY
    update()
  }

  function teardown() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    drag = null
    offset.value = 0
    draggingKey.value = null
  }

  function onUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const keys = moveKey(drag.keys, drag.key, target.value)
    // Re-sort first, then drop the offsets: both land in the same render.
    preview.value = keys
    teardown()
    void finish(keys)
  }

  function onCancel(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    teardown()
  }

  function onGripPointerDown(key: ReorderKey, event: PointerEvent) {
    if (disabled?.value || drag) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const grip = event.currentTarget as HTMLElement | null
    const list = grip?.closest<HTMLElement>('[data-reorder-list]')
    if (!grip || !list) return
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-reorder-key]'))
    const keys = preview.value ?? savedKeys.value
    const from = keys.indexOf(key)
    if (from < 0 || rows.length !== keys.length) return
    event.preventDefault()
    const rects = rows.map((row) => row.getBoundingClientRect())
    const gap = rects.length > 1 ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 0
    drag = {
      key,
      pointerId: event.pointerId,
      keys: [...keys],
      from,
      mids: rects.map((r) => r.top + window.scrollY + r.height / 2),
      slot: rects[from]!.height + gap,
      startPageY: event.clientY + window.scrollY,
    }
    lastClientY = event.clientY
    offset.value = 0
    target.value = from
    draggingKey.value = key
    // On the window, not the grip: a release outside the grip (or after the
    // row was re-rendered) still has to end the drag.
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    rafId = requestAnimationFrame(autoscroll)
  }

  function onGripKeydown(key: ReorderKey, event: KeyboardEvent) {
    if (disabled?.value || drag) return
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return
    event.preventDefault()
    const keys = preview.value ?? savedKeys.value
    const from = keys.indexOf(key)
    const to = from + delta
    if (from < 0 || to < 0 || to >= keys.length) return
    const next = moveKey(keys, key, to)
    preview.value = next
    void finish(next)
  }

  onBeforeUnmount(teardown)

  return { ordered, draggingKey, rowStyle, onGripPointerDown, onGripKeydown }
}
