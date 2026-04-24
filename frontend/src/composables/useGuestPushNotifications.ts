import { createPushNotifications } from './usePushNotifications'
import {
  getGuestVapidKey,
  subscribeGuestPush,
  unsubscribeGuestPush,
} from '../api/sharedalbumPush'

/**
 * Token-scoped guest variant of `usePushNotifications`. Same browser
 * primitives, different backend endpoints (cookie-authenticated under
 * /share/:token/guests/push/...).
 */
export function useGuestPushNotifications(token: string) {
  return createPushNotifications({
    fetchVapidKey: () => getGuestVapidKey(token),
    subscribe: (req) => subscribeGuestPush(token, req),
    unsubscribe: (endpoint) => unsubscribeGuestPush(token, endpoint),
  })
}
