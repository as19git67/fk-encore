# The assistant in the iOS app

Status: **stages 1 (#1821) and 2 (#1822) done, stage 3 in progress.** Follows `ki-assistent.md` (what the
assistant is) and `assistent-wegfindung.md` (how it finds its way). This plan
is about bringing the same assistant to the iOS app, and about the shape the
iOS code needs so that a Finance app and a Documents app can share it later.

## What is there

The backend needs no change for a second client. Everything a client does is
an ordinary REST call under `/assistant` — conversations, `POST
…/conversations/:id/turns` (returns at once, the turn runs on), proposals with
`execute` / `discard`, `cancel`, the model gate — plus one WebSocket,
`/assistant/turns/:turnId/stream`, that only *watches* a turn. The turn keeps
running when the socket drops; a reconnect with `resume=true` replays the
whole turn; the answer is stored with the conversation. That is already the
shape a phone needs: the app may go to the background in the middle of a
question and lose nothing.

The web client authenticates the socket with `?token=`, which the gateway
downgrades to the media scope (`user/auth-handler.ts`). A native client can
send the bearer token as a header and keeps the full scope — nothing in the
protocol depends on the downgrade.

What the web client holds and a native client would have to hold too:

- the stream handling: ping every 25 s, replay on reconnect, cancel;
- the result blocks: 24 kinds, rows untyped (`Record<string, unknown>`),
  some 800 lines of knowledge in `AssistantBlock.vue` about which field is the
  title of a booking, a security, a parcel;
- the proposal cards: ten write tools plus the letter and the collage, with
  the continuation after "Ausführen" (`proposalEffects.ts`) and the caches to
  drop;
- navigation: rows carry web paths (`route`), the app has screens only for
  photos, albums, persons, recaps and trips (`AppDeepLink.swift`).

## Decisions

- **The server says how a row reads.** Every row of every block gets a
  `display` (`assistant/present.ts`): title, subtitle, the formatted figure
  at the right edge with its sign, a date, the web path that opens the
  object, and for photos and documents the id to load a thumbnail for. The
  block gets a `title`. A client with its own screen for a kind ignores
  `display`; for every other kind one generic row is enough. The web app
  keeps its renderers for now and may move to `display` kind by kind. The
  rows the model sees are unchanged — blocks are for the client only.
- **One assistant, not one per app.** Conversations live on the server, so
  every app shows the same history. The work context ("draft an answer to
  these three documents") comes from the app the user stands in. The
  assistant is not narrowed to the app's module: on the phone it knows what
  it knows on the web, only a tap on a row of another module leads elsewhere.
- **Three ways to open a row.** Native where the app has a screen (photos,
  albums, persons, recaps, trips, later finance in a Finance app); a PDF
  preview with QuickLook for documents, letters and bundles; the web page
  from `display.route` in an in-app web view for everything else (accounts,
  depot, tax, EÜR, meters).
- **Handing the session to the web view.** The web app does not know the
  app's session, and the bearer token must not travel in a URL. A small
  endpoint issues a one-time, short-lived handover token; the web view opens
  the page with it and is signed in. Until that exists the web view asks for
  a login once.
- **The assistant is a Swift package of its own**, not a feature folder in
  the Photos app. Today `ios/Package.swift` is one library target
  (`FKPhotosLib`) holding networking, auth and every feature. It becomes
  three layers:
  1. `F4milCore` — `APIClient`, `AuthManager`, keychain, the generated
     OpenAPI client, the deep-link catalog. Every app uses the same package;
     the session lives in the shared App Group keychain, which the share
     extension already reads. Signed in once, signed in everywhere.
  2. `F4milAssistant` — chat, stream, proposal cards, the generic row. It
     knows no app. On start it is handed the block kinds the surrounding app
     draws natively (with a view for each) and an opener that takes a
     `route`. The Photos app registers photos and albums, a Finance app
     accounts and bookings.
  3. The apps — a thin Xcode project each with its own icon, URL scheme and
     feature packages (`F4milPhotos`, `F4milFinance`, `F4milDocuments`).
  The opener tries the own app first, then a sister app by URL scheme
  (`canOpenURL`), last the web view. `AppDeepLink` becomes the shared route
  catalog that knows web path and app scheme of every module.
- **The model's slowness is the phone's problem too.** A GPU answer takes
  seconds to a minute; the screen shows the tool steps as they come, as the
  web does, and the app may be left — the answer is waiting in the
  conversation. A push when an answer finishes and nobody is watching
  (`push/apns.service.ts` has `sendToUserDevices`) is a later stage.

## Stages

1. **Display hints from the server** — done (#1821). `assistant/present.ts`
   with `presentBlock` (one rule per kind, mirroring `AssistantBlock.vue`),
   applied in the agent loop when a block arrives and when a conversation is
   read, so stored blocks carry it too. Nothing in the web app changes.
2. **Packages** — in progress. `ios/Package.swift` gets a second library
   target, `F4milCore` (`Sources/F4milCore`): `APIClient`,
   `AuthInterceptor`, `AuthManager`, `KeychainHelper`, `PasskeyManager`,
   `SharedSession`, `SharedStorage`, `AppDeepLink` and the session's wire
   types (`Role`, `UserWithRolesAndPermissions`, `LoginRequest`,
   `LoginResponse`, `SuccessResponse`), all `public`. `FKPhotosLib` depends
   on it and re-exports it (`@_exported import` in `Core/CoreExports.swift`),
   so none of the app's files changes its imports and the Xcode project
   keeps linking `FKPhotosLib`. Two seams had to be cut for the module
   boundary: `APIClient.uploadPhoto` is generic over the record the server
   returns (`UploadResult<Created>`, the app passes `Photo`) and takes the
   "Wi-Fi only" preference as `allowsCellularAccess` instead of reading
   `PhotoSyncPreferences`; `AuthManager` no longer calls `RemotePushManager`,
   `WidgetSnapshotStore` and `SpotlightIndexer` itself but runs the
   `willLogout` and `didClearSession` closures the app hands in
   (`AuthManager.forPhotosApp()`, used by `Main.swift`). The app is not
   renamed; `FKPhotosLib` stays the Photos app's module. CI builds the
   package, its tests and both extensions on macOS (`ios-tests.yml`), which
   is the proof — the server-side sandbox has no Swift toolchain.
3. **Read-only assistant** — in progress. Package `F4milAssistant`
   (`Sources/F4milAssistant`, on `F4milCore` only): the wire types of
   `/assistant` as the server writes them (`Models/`), `AssistantAPI` over
   `APIClient`, and `TurnFollower`, a `URLSessionWebSocketTask` that opens
   the stream with the bearer token as a header (`APIClient.webSocketRequest`,
   full scope, no `?token=`), posts the turn once the socket is up, treats
   60 s of silence as a dead socket (the server pings every 25 s), reopens
   with `resume=true` on the web's schedule (1, 2, 4, 8, 15, 30 s) and skips
   the replayed events it has shown (`ReplayCursor`). `LiveTurn` is the
   reducer of `assistantTurn.ts` ported one to one — drafts before a tool
   call, withdrawn answers, steps, blocks — so web and phone read a turn the
   same way, with a test per event. The screens: `AssistantRootView`
   (conversations, swipe to delete, "Neue Unterhaltung"), `ConversationView`
   (messages, the running turn with its steps and "Abbrechen", the model
   gate's notice, the question field; the conversation is created on the
   first question), `BlockView` and `ResultRowView` (title, "n von total",
   "Liste", one generic row from `display`: date, thumbnail through the API
   client, title, subtitle, figure coloured by `tone`; folded after eight
   rows), `MarkdownText` (paragraphs, headings, lists; inline Markdown via
   `AttributedString`). Opening a row (`RowOpener`): the host app first
   (`AssistantHost.openRoute`, given the route and its web URL), else
   `/dokumente/<id>` as a QuickLook preview of `/documents/:id/file`, else
   the web page under `/app` in `SFSafariViewController` (login once until
   stage 5). The Photos app (`Features/Assistant/AssistantEntry.swift`)
   shows the button in the feed toolbar to whoever has `module.assistant`
   and takes the rows `AppDeepLink.parse` knows — photos, albums, persons,
   recaps — through `AppDeepLinkRouter`, the same way a notification tap
   does. Proposal cards show as rows for now; stage 4 gives them buttons.
4. **Proposal cards.** Execute, discard, the continuation after execute,
   invalidating the app's caches (albums). The letter as PDF preview with
   the share sheet; editing the letter on the phone is not in this stage.
5. **Session handover to the web view** — the one-time token endpoint, so a
   finance row opens signed in.
6. **Context and entry points.** "Assistent fragen" from a photo selection
   and from an album (the context the web passes as `?context=`); a push
   when an answer finishes unwatched.
7. **Optional.** App Intents / Siri for a question; the share sheet as
   context.

## Risks

- Stages 2 and 3 are written without a Swift toolchain at hand; the iOS
  workflow on macOS is what proves it, and a red run there is worked from
  its log. Stage 2's one red run was a test reading a moved file by its old
  path, not the Swift.
- Two renderers, web and iOS, would drift; `display` from the server is the
  answer, and a new block kind gets its rule in `present.ts` first.
- A finance row without the handover token ends on a login page in the
  web view; stage 5 removes that, stage 3 ships with it.
- The stream on a phone network drops more often than in a browser; the
  resume path exists but is exercised rarely on the web and needs a test on
  the device.
