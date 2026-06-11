import { useRouter } from 'vue-router'

/**
 * Returns a goBack function that stays within the given module basePath.
 * Uses browser history only if the previous entry belongs to the same module;
 * otherwise navigates to the specified fallback route.
 */
export function useModuleBack(basePath: string, fallbackRouteName: string) {
  const router = useRouter()

  function goBack() {
    const back = window.history.state?.back as string | undefined
    if (back?.startsWith(basePath)) {
      router.back()
    } else {
      void router.push({ name: fallbackRouteName })
    }
  }

  return { goBack }
}
