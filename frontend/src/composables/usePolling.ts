import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Run `fn` every `intervalMs` while the calling component is mounted.
 *
 * The OSM region list used to be polled from the shared data-management page
 * for as long as that page was open, regardless of which section the admin
 * was actually looking at. Tying the timer to the component that needs it
 * keeps the polling to the one page that shows the data.
 *
 * Pass `enabled: false` to skip the timer entirely (e.g. the user lacks the
 * permission the polled endpoint requires).
 */
export function usePolling(
  fn: () => void,
  intervalMs: number,
  options: { enabled?: boolean } = {},
): void {
  let timer: number | null = null

  onMounted(() => {
    if (options.enabled === false) return
    timer = window.setInterval(fn, intervalMs)
  })

  onBeforeUnmount(() => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  })
}
