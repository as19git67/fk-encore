# AI-Queue: Push-Wakeup statt Sekunden-Polling

Status: **Umgesetzt** — `ai-queue/waiters.ts`, `ai-queue/api.ts`,
`ai-queue/slot-helper.ts` samt Tests
(`ai-queue/waiters.test.ts`, `ai-queue/slot-helper.test.ts`, erweiterte
`ai-queue/api.test.ts`).

## Problem

`ai-queue` serialisiert den Zugriff auf die externen AI-Services (llm,
embedding, insightface) über die Tabelle `ai_model_slot`: pro Modell genau
ein `active`-Slot, alle weiteren Anfragen warten priorisiert.

Das Warten ist heute Polling: `withAiSlot()` (in
`ai-queue/slot-helper.ts`) ruft im Wartezustand jede Sekunde
`pollSlot` auf (`AI_QUEUE_POLL_INTERVAL_MS`, Default 1000 ms). Jeder Poll
kostet zwei SQL-Queries (Status + Positionsberechnung). Bei Kontention —
z. B. photo-embedding, photo-quality, documents-scan und finance-tagging
gleichzeitig auf `llm`/`embedding` — entsteht dauerhafter, nutzloser
DB-Traffic, obwohl sich am Zustand meist nichts ändert.

## Kernidee

**Der Slot-Inhaber weckt beim Freigeben den nächsten Warter direkt auf,
statt dass alle Warter pollen.**

Entscheidende Vereinfachung gegenüber einer vollständigen
Dispatcher-Inversion („ai-queue ruft den App-Service zurück und der
verteilt den nächsten Job"): Das gefürchtete Ketten-Problem — *„wenn die
Queue leer ist, gibt es keinen zukünftigen Trigger mehr; neue Elemente
müssten die Kette neu anstoßen"* — existiert in der heutigen Struktur
gar nicht, wenn man nur das **Warten** push-basiert macht:

- `acquireSlot` prüft **atomar** beim Einreihen, ob ein Slot frei ist,
  und aktiviert sofort (`INSERT` + bedingtes `UPDATE`). Der
  Acquire-Aufruf selbst ist also immer der „initiale Trigger" — eine
  leere Queue braucht kein Re-Priming.
- `releaseSlot` promotet bereits heute den nächsten Warter in der DB
  (`waiting` → `active`). Es fehlt nur die Benachrichtigung des
  wartenden Aufrufers — genau die ersetzt das Polling.

Die Job-Queues der Services (photo scan-queue, documents scan-queue,
finance tag-queue) bleiben unverändert: Jeder Worker dequeued weiterhin
selbst und schedult seine konkurrierenden Queues selbst (Concurrency,
Backpressure, Service-Health, Backup-Pause). Nur die Wartephase in
`withAiSlot` wird ereignisgesteuert.

### Warum keine vollständige Inversion?

Die Variante „ai-queue ruft bei freiem Slot einen Callback-Endpoint des
App-Services auf, der dann den nächsten Job dequeued" wurde bewusst
verworfen:

1. **Zustand verteilt sich auf zwei Systeme.** Der Worker hält den Job
   heute bereits dequeued, während er auf den Slot wartet; bei Inversion
   müsste der Job entweder zurückgelegt oder die Job-Auswahl in die
   ai-queue verlagert werden.
2. **Scheduling-Vorbedingungen müssten dupliziert werden.** Die Worker
   prüfen vor dem Dequeue Event-Loop-Pressure, Service-Health,
   Backup-Pause etc. Ein Callback aus der ai-queue müsste all das erneut
   prüfen und bei „passt gerade nicht" den Slot weiterreichen —
   zusätzliche Fehlerpfade.
3. **Das Re-Priming-Problem entstünde dadurch erst** (leere Queue → kein
   Trigger → App-Service muss „initiales Element" einspeisen). Mit dem
   Wakeup-Ansatz bleibt die Acquire-Semantik selbstanstoßend.

Das Wakeup-Design erreicht dasselbe Ziel (kein Polling, sofortige
Slot-Übergabe) mit einem Bruchteil des Umbaus.

## Randbedingung: Prozess-Topologie

Alle Encore-TS-Services laufen self-hosted als **ein** Node-Prozess (ein
`fk-encore`-Container, siehe `docker-compose.yml`); sie teilen sich eine
Postgres-DB über einen gemeinsamen Pool (`db/database.ts`). Damit
funktioniert ein **In-Process-Waiter-Registry** (Modul-Singleton):
`ai-queue/api.ts` (weckt) und `ai-queue/slot-helper.ts` (wartet) sehen
dieselbe Registry-Instanz.

Sollte die Topologie je auf mehrere Prozesse aufgeteilt werden, greift
der Fallback-Poll (s. u.) — das System degradiert dann zu langsamem
Polling statt zu hängen. Phase 2 (optional, nur bei Bedarf): Postgres
`LISTEN/NOTIFY` als prozessübergreifender Wakeup-Kanal.

## Design

### 1. Neues Modul `ai-queue/waiters.ts` (In-Process-Registry)

```ts
// Map slotId → resolve-Funktion des wartenden Promise
const waiters = new Map<number, () => void>();

/** Registriert einen Warter. Auflösung durch wakeWaiter(slotId). */
export function registerWaiter(slotId: number): Promise<void>;

/** Entfernt einen Warter (Timeout/Cancel), idempotent. */
export function unregisterWaiter(slotId: number): void;

/** Weckt den Warter für slotId, falls registriert. No-op sonst. */
export function wakeWaiter(slotId: number): void;
```

Kein Timer, kein Zustand außer der Map. `wakeWaiter` für einen nicht
(mehr) registrierten Slot ist bewusst ein No-op — der Slot wurde dann
entweder schon aktiv gesehen oder per Timeout gecancelt (der
Cleanup-Cron räumt verwaiste `active`-Slots ohnehin ab).

### 2. `ai-queue/api.ts`: Promotion meldet den Gewinner

Überall, wo ein Warter `waiting → active` promotet wird, liefert das
`UPDATE … RETURNING id` den Gewinner, und der Aufrufer weckt ihn:

- **`releaseSlot`**: nach der Promotion `wakeWaiter(promotedId)`.
- **`cleanupStaleSlots`**: dito je betroffenem Modell.

Das sind die einzigen beiden Stellen, an denen ein wartender Slot aktiv
wird (in `acquireSlot` aktiviert sich nur der frisch eingefügte Slot
selbst — dessen Aufrufer bekommt das Ergebnis synchron zurück).

### 3. `ai-queue/slot-helper.ts`: Warten ohne Sekunden-Poll

```ts
if (slot.status === "waiting") {
  const wakeup = registerWaiter(slotId);        // (a) zuerst registrieren
  try {
    // (b) Race-Schutz: Promotion zwischen acquire-Antwort und (a)?
    const recheck = await aiqueue.pollSlot({ slotId });
    if (recheck.status !== "active") {
      if (recheck.status === "cancelled") throw new AiSlotTimeoutError(...);
      // (c) warten: Wakeup ODER Fallback-Poll ODER Timeout
      await waitForActive(slotId, wakeup, timeoutMs);
    }
  } finally {
    unregisterWaiter(slotId);
  }
}
```

`waitForActive` implementiert die Warteschleife:

- **Primär:** `await wakeup` — der Normalfall, Latenz ≈ 0 statt bis zu
  1 s heute.
- **Fallback-Poll:** alle `AI_QUEUE_FALLBACK_POLL_MS` (Default
  **30 000 ms**) ein `pollSlot` als Sicherheitsnetz gegen verlorene
  Wakeups (Bug, künftige Multi-Prozess-Topologie). Meldet der Poll
  `active`, ist das gleichwertig zum Wakeup; `cancelled` → Abbruch.
- **Timeout:** wie heute (`AI_QUEUE_SLOT_TIMEOUT_MS`, Default 5 min) —
  bei Ablauf `cancelSlot` + `AiSlotTimeoutError`.
- **Verifikation nach Wakeup:** nach einem Wakeup ein einzelnes
  `pollSlot` zur Bestätigung (`active`?). Kostet eine Query im seltenen
  Wakeup-Moment statt jede Sekunde und macht die Registry rein
  advisory — die DB bleibt alleinige Source of Truth. Falls der Status
  wider Erwarten noch `waiting` ist (sollte nicht vorkommen), weiter
  warten bis Fallback-Poll/Timeout.

Wichtige Race-Betrachtung:

| Race | Behandlung |
| --- | --- |
| Promotion passiert, bevor der Warter registriert ist (zwischen `acquireSlot`-Antwort und `registerWaiter`) | Einmaliger `pollSlot`-Recheck direkt nach der Registrierung (Schritt b) |
| Wakeup trifft ein, nachdem der Warter per Timeout aufgegeben hat | `wakeWaiter` ist No-op für unregistrierte Slots; der per `cancelSlot` gelöschte bzw. vom Cleanup-Cron abgeräumte Slot blockiert nichts dauerhaft |
| Timeout und Wakeup gleichzeitig (Slot rast im Timeout-Moment auf `active`) | `waitForActiveSlot` ruft beim Timeout `cancelSlot` — das löscht nur eine noch `waiting`e Zeile und verhindert, dass der `finally`-`releaseSlot` fälschlich einen zweiten aktiven Slot promotet. Ist der Slot schon `active`, ist `cancelSlot` ein No-op und der `finally`-`releaseSlot` in `withAiSlot` gibt ihn frei und promotet den Nächsten. |

Dieses Zusammenspiel (`cancelSlot` für den Waiting-Fall, `finally`-`releaseSlot`
für den Aktiv-Race) war schon in der Poll-Variante korrekt und bleibt so
erhalten — `cancelSlot`-vor-`throw` ist dabei lasttragend, weil ein
`releaseSlot` auf einer noch `waiting`en Zeile sonst einen zweiten aktiven
Slot promoten würde.

### 4. Konfiguration

| Variable | vorher | nachher |
| --- | --- | --- |
| `AI_QUEUE_POLL_INTERVAL_MS` | 1000 ms aktives Polling | **entfällt** — wird nicht mehr gelesen |
| `AI_QUEUE_FALLBACK_POLL_MS` | — | neu, Default 30 000 ms (Sicherheitsnetz, pro Warteschritt aus der Env gelesen) |
| `AI_QUEUE_SLOT_TIMEOUT_MS` | 300 000 ms | unverändert |
| `AI_QUEUE_STALE_TTL_MINUTES` | 5 min | unverändert (Cleanup-Cron bleibt als Absicherung gegen abgestürzte Inhaber) |

### 5. Unverändert

- Tabelle `ai_model_slot`, Prioritäts-/FIFO-Ordnung, `FOR UPDATE SKIP
  LOCKED`-Promotion — keine Migration nötig.
- API-Verträge von `acquireSlot`/`pollSlot`/`releaseSlot`/`cancelSlot`
  (`pollSlot` bleibt für Fallback, Status-UI und Tests erhalten).
- Alle Aufrufer (`photo/scan-worker.ts`, `documents/scan-worker.ts`,
  `finance/tag-worker.ts`) — die Signatur von `withAiSlot` ändert sich
  nicht.
- Cleanup-Cron (`ai-queue/cleanup-cron.ts`).

## Tests (`ai-queue/api.test.ts` + neu `ai-queue/slot-helper.test.ts`)

1. **Wakeup-Happy-Path:** Warter B auf Modell X; `releaseSlot(A)` →
   B's `withAiSlot` läuft ohne Fallback-Poll weiter (messbar über kurze
   Gesamtdauer ≪ Fallback-Intervall).
2. **Prioritäten:** zwei Warter (p1, p2) — Release weckt den
   p1-Warter, der p2-Warter bleibt registriert und wartet weiter.
3. **Race acquire→register:** Promotion vor `registerWaiter` simulieren
   → der Recheck fängt es, kein Hänger.
4. **Timeout:** kein Release → `AiSlotTimeoutError` nach `timeoutMs`,
   Slot-Zeile ist entfernt, Registry leer (`unregisterWaiter` griff).
5. **Timeout trifft aktivierten Slot:** Slot wird unmittelbar vor dem
   Timeout aktiv → Freigabe statt Leiche; nächster Warter rückt nach.
6. **Cleanup-Cron weckt:** stale `active` + ein Warter →
   `cleanupStaleSlots` promotet und weckt.
7. **Fallback-Poll:** Wakeup unterdrücken (Registry gezielt leeren) →
   Warter kommt trotzdem über den Fallback-Poll zum Zug.
8. Bestehende `api.test.ts`-Fälle bleiben grün (Verträge unverändert).

## Umsetzungsetappen

1. `ai-queue/waiters.ts` + Unit-Tests der Registry.
2. `api.ts`: Promotion mit `RETURNING id` + `wakeWaiter` in
   `releaseSlot` und `cleanupStaleSlots`.
3. `slot-helper.ts`: Warteschleife umbauen (register → recheck →
   race(wakeup, fallback, timeout)), Timeout-Pfad mit
   release-statt-cancel für bereits aktivierte Slots.
4. Integrations-Tests (Liste oben), `npm run test` grün.
5. Doku-Feinschliff (dieses Dokument auf „umgesetzt" stellen,
   Env-Variablen in DEPLOYMENT.md ergänzen, falls dort gelistet).

Aufwand: klein — drei Dateien plus Tests, keine Migration, keine
API-Änderung nach außen.

## Phase 2 (optional): Multi-Prozess-Fähigkeit

Nur falls die Encore-Services je auf mehrere Prozesse/Container
aufgeteilt werden: `releaseSlot`/Cleanup feuern zusätzlich
`pg_notify('ai_slot_activated', slotId)`; ein dediziertes
Listener-Connection-Modul pro Prozess verteilt eingehende
Notifications an die lokale Registry. Registry-API und `withAiSlot`
bleiben dabei unverändert — es ändert sich nur die Transportschicht
des Wakeups.
