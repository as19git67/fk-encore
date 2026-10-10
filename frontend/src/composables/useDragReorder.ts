import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'

/**
 * Reordering a vertical list by dragging a grip, with mouse, finger or pen.
 *
 * Built on pointer events rather than the HTML5 drag-and-drop API: that API
 * never fires for a finger on iOS Safari and draws its own ghost image we
 * cannot style. Here the row itself moves — the list re-renders in the
 * would-be order while the pointer travels, so what you see on release is
 * what gets saved.
 *
 * The grip doubles as the keyboard handle: ArrowUp/ArrowDown on the focused
 * grip move the row by one, so dragging is never the only way to reorder.
 *
 * Rows are found through the DOM: the list carries `data-reorder-list`, every
 * row `data-reorder-key="<key>"`. Measuring the rows on each move (instead of
 * once at the start) keeps the target right while the page auto-scrolls.
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

  let listEl: HTMLElement | null = null
  let grip: HTMLElement | null = null
  let pointerId: number | null = null
  let lastY = 0
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

  function updateTarget(y: number) {
    const key = draggingKey.value
    if (key === null || !listEl || !preview.value) return
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>('[data-reorder-key]'))
    const mids = rows
      .filter((row) => row.dataset.reorderKey !== String(key))
      .map((row) => {
        const rect = row.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
    const next = moveKey(preview.value, key, reorderTargetIndex(mids, y))
    if (!sameOrder(next, preview.value)) preview.value = next
  }

  function autoscroll() {
    rafId = 0
    if (draggingKey.value === null) return
    const h = window.innerHeight
    let step = 0
    if (lastY < AUTOSCROLL_EDGE) step = -Math.ceil(((AUTOSCROLL_EDGE - lastY) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX_STEP)
    else if (lastY > h - AUTOSCROLL_EDGE)
      step = Math.ceil(((lastY - (h - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX_STEP)
    if (step !== 0) {
      window.scrollBy(0, step)
      updateTarget(lastY)
    }
    rafId = requestAnimationFrame(autoscroll)
  }

  function onMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    event.preventDefault()
    lastY = event.clientY
    updateTarget(lastY)
  }

  function teardown() {
    if (grip) {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeEventListener('pointercancel', onCancel)
      if (pointerId !== null && grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId)
    }
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    grip = null
    listEl = null
    pointerId = null
    draggingKey.value = null
  }

  function onUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    const keys = preview.value ?? savedKeys.value
    teardown()
    void finish(keys)
  }

  function onCancel(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    teardown()
    preview.value = null
  }

  function onGripPointerDown(key: ReorderKey, event: PointerEvent) {
    if (disabled?.value || draggingKey.value !== null) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.currentTarget as HTMLElement | null
    const list = target?.closest<HTMLElement>('[data-reorder-list]')
    if (!target || !list) return
    event.preventDefault()
    grip = target
    listEl = list
    pointerId = event.pointerId
    lastY = event.clientY
    preview.value = [...savedKeys.value]
    draggingKey.value = key
    target.setPointerCapture?.(event.pointerId)
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onCancel)
    rafId = requestAnimationFrame(autoscroll)
  }

  function onGripKeydown(key: ReorderKey, event: KeyboardEvent) {
    if (disabled?.value || draggingKey.value !== null) return
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

  return { ordered, draggingKey, onGripPointerDown, onGripKeydown }
}
