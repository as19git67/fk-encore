/* F4mil Web Push service worker.
 *
 * Receives `push` events from the browser's push service and shows a
 * notification with the payload the backend sent. Clicking the
 * notification opens (or focuses) the deep-link URL.
 */

self.addEventListener('install', (event) => {
  // Activate immediately so a freshly-installed SW starts receiving
  // push events without a full page reload.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (err) {
    payload = { title: 'F4mil', body: event.data ? event.data.text() : '' }
  }

  const title = payload.title || 'F4mil'
  const options = {
    body: payload.body || '',
    icon: '/app/icon-192.png',
    badge: '/app/icon-192.png',
    tag: payload.tag,
    // Keep previous notifications visible when multiple arrive with
    // different tags, but collapse when the same tag repeats.
    renotify: !!payload.tag,
    data: {
      // Default to the SPA root; bare "/" redirects but /app/ is the
      // canonical entry and avoids a round-trip.
      url: payload.url || '/app/',
      ...(payload.data || {}),
    },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/app/'
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      // Focus an existing tab if one is already on our origin.
      for (const client of allClients) {
        try {
          const url = new URL(client.url)
          if (url.origin === self.location.origin) {
            await client.focus()
            if ('navigate' in client) {
              try {
                await client.navigate(targetUrl)
              } catch {
                // Ignore cross-origin navigation errors.
              }
            }
            return
          }
        } catch {
          // Ignore malformed URLs.
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl)
      }
    })(),
  )
})
