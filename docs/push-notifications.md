# Web Push Notifications

## Overview

Feed events — album shares, photo adds to shared albums, likes and
comments — are delivered to opted-in users as browser push
notifications. Delivery uses the standard Web Push protocol (RFC 8030)
with VAPID authentication (RFC 8292), so it works across Chromium,
Firefox and Safari without any cloud-specific SDK.

Push is an optional *delivery channel* on top of the feed, not a
standalone feature. The feed's fan-out is the source of truth; push is
best-effort and failures never affect the underlying action (uploading
a photo, adding a comment, etc.).

When the three VAPID secrets are absent the feature stays silently
off: the public-key endpoint reports `enabled: false`, the Profile
page explains that push is not configured, and the feed fan-out skips
the push leg entirely.

## Architecture

### Components

| Component | Purpose |
|-----------|---------|
| `push/push.service.ts` | VAPID configuration, subscription CRUD, `sendToUser` with 404/410 pruning, feed-event → notification mapping (`buildFeedNotification`). |
| `push/push.ts` | HTTP surface: `GET /push/vapid-public-key`, `POST /push/subscribe`, `POST /push/unsubscribe`; internal `fanoutFeed` used by `feed.service` via `~encore/clients`. |
| `db/push_subscriptions` | One row per browser subscription — `user_id`, `endpoint`, `p256dh`, `auth`, `user_agent`. `endpoint` is globally unique so resubscribing from the same browser upserts the same row. Cascades on user delete. |
| `feed/feed.service.ts` | After every `emitFeedItems` call, looks up actor + album names and calls `push.fanoutFeed` for each recipient. Fire-and-forget — all push errors are logged and swallowed. |
| `frontend/public/push-sw.js` | Service worker. Handles `push` events (parses JSON payload, shows notification) and `notificationclick` (focuses an existing tab on our origin or opens a new one). |
| `frontend/src/composables/usePushNotifications.ts` | Browser-side state machine (`unsupported` / `disabled-server` / `denied` / `unsubscribed` / `subscribed`) and the subscribe/unsubscribe flow. |
| `frontend/src/views/ProfileView.vue` | "Benachrichtigungen" card — per-device opt-in toggle. |

### Delivery flow

```
user action (upload/like/comment/share)
   → feed.emitFeedItems
       → INSERT feed_items (one row per recipient)
       → realtime.publishEvent  (WebSocket fan-out for open feed views)
       → for each recipient: push.fanoutFeed
            → buildFeedNotification (title/body/url/tag)
            → sendToUser
                 → web-push.sendNotification per subscription
                 → prune 404/410 subscriptions
```

### Notification content

`buildFeedNotification` maps a `FeedItemKind` to a short German
notification. Both the title and body stay out of `feed.service` so
there's only one place that knows about notification wording.

| Kind | Title | Body template |
|------|-------|---------------|
| `photo_added` | "Neues Foto" | `<actor> hat ein Foto zu „<album>" hinzugefügt` |
| `album_shared` | "Album geteilt" | `<actor> hat das Album „<album>" mit dir geteilt` |
| `photo_liked` | "Gefällt mir" | `<actor> hat ein Foto mit ❤ markiert` |
| `photo_commented` | "Neuer Kommentar" | `<actor>: <excerpt>` (or `<actor> hat ein Foto kommentiert` if the excerpt is empty) |

Each payload carries:

- `url` — deep-link that the service worker opens on click
  (`/fotos/alben/<albumId>[?photoId=…]`, or `/fotos/feed` as fallback).
- `tag` — `<kind>:<albumId>:<photoId>`. Collapses repeated events for
  the same photo from the same actor so the tray doesn't stack
  duplicates.
- `data.kind`, `data.albumId`, `data.photoId` — forwarded verbatim so
  the SPA can refresh the relevant view.

## Operator setup

Push requires three Encore secrets:

| Secret name        | Value |
|--------------------|-------|
| `VapidPublicKey`   | Base64url-encoded VAPID public key |
| `VapidPrivateKey`  | Base64url-encoded VAPID private key |
| `VapidSubject`     | RFC 8292 "sub" — a `mailto:` or `https://` URL identifying the server operator |

`infra-config.json` (baked into the docker image at build time via
`encore build docker --config=infra-config.json`) maps each secret to
an environment variable, so deploys never carry the secret values in
the image:

```json
{
  "secrets": {
    "VapidPublicKey":  { "$env": "VAPID_PUBLIC_KEY" },
    "VapidPrivateKey": { "$env": "VAPID_PRIVATE_KEY" },
    "VapidSubject":    { "$env": "VAPID_SUBJECT" }
  }
}
```

Generate the keypair once (any machine, throw-away Node):

```bash
npx web-push generate-vapid-keys
```

For docker-compose deploys put the values in `.env` next to
`docker-compose.yml`:

```env
VAPID_PUBLIC_KEY=…
VAPID_PRIVATE_KEY=…
VAPID_SUBJECT=mailto:admin@my-domain.com
```

For local `encore run` development use `.secrets.local.cue`:

```cue
VapidPublicKey: "…"
VapidPrivateKey: "…"
VapidSubject: "mailto:dev@localhost"
```

Restart the app after setting or changing the secrets — VAPID details
are cached on first use. Never rotate `VapidPublicKey` without
informing users: every existing browser subscription is bound to the
public key it was issued under, so a rotation invalidates every
subscription and users must opt in again.

## Client opt-in flow

1. User opens **Profil → Benachrichtigungen**.
2. `usePushNotifications.refreshState()` runs:
   - Checks browser capabilities (`serviceWorker`, `PushManager`,
     `Notification`) → `unsupported` if any are missing.
   - Fetches `/push/vapid-public-key` → `disabled-server` if the
     backend returns `enabled: false`.
   - Reads `Notification.permission` → `denied` if blocked.
   - Reads the existing service-worker subscription → `subscribed` /
     `unsubscribed`.
3. Clicking **Aktivieren** triggers `subscribe()`:
   1. `Notification.requestPermission()` — requires a user gesture.
   2. Registers `/push-sw.js` as the service worker.
   3. `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
      using the VAPID public key.
   4. `POST /push/subscribe` with the endpoint + `p256dh` + `auth`
      keys + `navigator.userAgent`.
4. Clicking **Deaktivieren** calls `POST /push/unsubscribe` with the
   endpoint, then `PushSubscription.unsubscribe()` to clear the
   browser-side state.

The toggle is per device. A user with three browsers and a phone ends
up with four rows in `push_subscriptions`; each is independently
active and independently prunable.

## Subscription lifecycle

- **Create / refresh** — `POST /push/subscribe` uses `ON CONFLICT
  (endpoint) DO UPDATE`, so the same browser re-subscribing (e.g.
  after a key rotation on the push service) refreshes `p256dh` /
  `auth` / `user_agent` and re-binds the row to whichever user is
  currently logged in.
- **Explicit removal** — `POST /push/unsubscribe` with the endpoint,
  scoped to the current user. Anonymous / cross-user deletes are not
  allowed.
- **Implicit pruning** — every `sendToUser` call that hits a 404 or
  410 from the push service deletes the offending row immediately. The
  push service returns 410 Gone once a user denies the permission in
  the browser or uninstalls the PWA, so the DB self-heals without any
  background job.
- **User deletion** — `push_subscriptions.user_id` cascades on
  delete, so removing a user takes their subscriptions with them.

## Service worker

`/push-sw.js` is intentionally minimal and has two responsibilities:

- On `push`, parse the JSON payload and call
  `self.registration.showNotification(title, options)` with the icon,
  tag and `data.url` from the payload. Missing or malformed payloads
  fall back to a generic "Vivanty" notification.
- On `notificationclick`, close the notification, then focus an
  existing window on our origin (navigating it to the payload's URL if
  the `navigate` method is available) or open a new one.

The worker calls `skipWaiting()` on install and `clients.claim()` on
activate so a freshly installed SW starts delivering push events
immediately without a full page reload.

## Testing

- Unit tests mock `~encore/clients` in `vitest.setup.ts`, so
  `push.fanoutFeed` is a no-op during test runs.
- For a manual end-to-end check, trigger any feed event (share an
  album, add a photo to a shared album, like a photo) while a second
  opted-in browser has the tab closed. The notification should arrive
  within a few seconds and click through to the album view.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Profile card shows "Push ist auf dem Server nicht konfiguriert." | One or more of `VapidPublicKey` / `VapidPrivateKey` / `VapidSubject` is missing. Run `encore secret list` and re-set the missing ones. App restart required. |
| Profile card shows "Benachrichtigungen wurden im Browser blockiert." | The user has denied the notification permission at the browser level. Only the user can re-grant this via the browser's site-settings UI. |
| Subscribe succeeds but no notifications arrive | Check the app logs for `[push] send failed`. A 403 usually means the VAPID subject is malformed (must be a URL or `mailto:`). Check that the browser is not muted (system DND, focus mode). |
| Repeated `[push] send failed status=401` | VAPID keypair mismatch — the public key served to the browser doesn't match the private key signing the request. Happens if you rotated one secret but not the other. Re-subscribe users after any VAPID rotation. |
| Clicking a notification opens a new tab every time | Expected if no existing SPA tab is open. When a tab is already open, the service worker focuses it and navigates to the deep-link URL. |
| Notifications stop after a while on iOS | iOS only delivers push to PWAs that have been **installed to the home screen**. A notification-allowed Safari tab will not receive pushes. |
