import { h, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import type { Decorator } from '@storybook/vue3'

/**
 * Puts the stub router on the route a view expects (issue #1281).
 *
 * A view that reads `route.params` or `route.query` renders nothing useful
 * until the router is on its page — and the query is often the state the
 * story is about ("filtered down to nothing").
 *
 * One decorator on `meta`, and each story names its route through the
 * `route` parameter. Doing it with a decorator per story does not work:
 * Storybook nests story decorators *inside* meta ones, so the story pushes
 * its route first and the meta decorator then pushes over it — which is how
 * a "no results" story quietly rendered the unfiltered list.
 *
 * The view is held back until the navigation has settled. `router.push` is
 * a promise, and a view that loads in `onMounted` otherwise fetches against
 * whatever route it happened to mount on — the same "no results" story then
 * asked for the list without its filter and rendered the full one.
 */
export function routeFromParameters(fallback: string): Decorator {
  return (story, context) => {
    const target = (context.parameters.route as string | undefined) ?? fallback
    return {
      setup() {
        const StoryComponent = story() as Component
        const router = useRouter()
        const ready = ref(router.currentRoute.value.fullPath === target)
        if (!ready.value) {
          router.push(target).then(
            () => { ready.value = true },
            () => { ready.value = true },
          )
        }
        return () => (ready.value ? h(StoryComponent) : null)
      },
    }
  }
}
