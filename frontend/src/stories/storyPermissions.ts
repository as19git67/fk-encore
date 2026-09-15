import type { Decorator } from '@storybook/vue3'
import { useAuthStore } from '../stores/auth'
import { MOCK_USER } from './mock-data'

/**
 * Render a story as a user holding exactly `permissions`.
 *
 * The preview sets up a full-permission admin; the admin pages hide parts of
 * themselves per permission, so the interesting stories are the reduced ones.
 */
export function withPermissions(permissions: string[]): Decorator {
  return () => ({
    setup() {
      const auth = useAuthStore()
      auth.user = { ...MOCK_USER, permissions }
      return {}
    },
    template: '<story />',
  })
}
