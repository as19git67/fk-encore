# Hängende Jobs in der Dokumenten-Warteschlange

## Symptom

Nach einem Re-Classify bleiben im Queue-Panel ein oder mehrere Jobs — meist
beim Dienst *Embedding* — auf **wartend** stehen und ändern sich über Stunden
nicht. In der Dokumentliste lässt sich kein Filter setzen, unter dem genau
diese Dokumente übrig bleiben.

## Warum das unsichtbar war

Zwei Eigenschaften der Pipeline haben sich zu einer stillen Endlosschleife
addiert:

1. **Zurückstellen war unbegrenzt.** Ein Job, der nicht laufen kann, wird
   „deferred": er geht zurück auf `pending`, ohne einen Versuch zu
   verbrauchen (`deferJob` in `documents/scan-queue.ts`). Gedacht ist das für
   „gleich nochmal" — Upstream noch nicht fertig, llm-service startet neu,
   AI-Queue-Slot noch nicht frei. Es gab aber keine Obergrenze. Eine
   Bedingung, die nie verschwindet (der `/embed`-Aufruf läuft für genau
   dieses Dokument in den Timeout, ein AI-Slot wird nie aktiv, ein
   `documents.status` aus einem abgebrochenen Lauf ist veraltet), ließ den Job
   endlos zwischen `pending` und `processing` kreisen.

2. **`embed` fasst den Dokumentstatus nicht an.** Das ist Absicht — ein
   fehlendes Embedding soll ein Dokument nicht aus der UI nehmen. Es heißt
   aber auch: das Dokument steht auf `ready` wie jedes andere. Kein
   Statusfilter der Liste konnte die betroffenen Dokumente zeigen, und
   fehlgeschlagen war auch nichts.

Dazu kam ein konkreter Auslöser für Fall 1: `runEmbed`/`runClassify` haben
`documents.status` als „kommt da noch Text?"-Signal benutzt. Ein Re-Queue
setzt den Status vorab auf `pending`; bleibt ein Lauf davor stehen, ist der
Status dauerhaft veraltet, und der nachgelagerte Job stellt sich für immer
zurück.

## Was jetzt passiert

* **Begrenztes Zurückstellen.** `document_scan_queue.defer_count` zählt jede
  Zurückstellung, `DOC_SCAN_MAX_DEFERS` (Default 50, bei 30 s Poll-Intervall
  also mindestens ~25 Minuten Nachsicht) begrenzt sie. Danach wird der Job als
  **fehlgeschlagen** markiert — mit dem letzten Grund im Text. Damit taucht er
  in der Fehlerspalte auf und lässt sich über „Fehlgeschlagene wiederholen"
  erneut anstoßen.
* **Der Grund ist sofort sichtbar.** `deferJob` schreibt den Grund in
  `error_msg`, schon während der Job noch wartet.
* **Die Warteschlange entscheidet, nicht der Status.** `hasAnyJob()` trennt
  „text_extract läuft noch" von „text_extract ist gelaufen und hat nichts
  geliefert". Nur im schmalen Fenster, in dem der Status schon auf `pending`
  steht und die text_extract-Zeile noch nicht eingefügt ist, wird überhaupt
  gewartet.
* **Das Panel nennt die Dokumente.** `GET /document-queue/status` liefert
  zusätzlich die offenen Jobs (`jobs`) mit Dokument-ID, Titel, Dienst,
  Wartezeit, Anzahl Zurückstellungen und Grund. Das Queue-Panel zeigt daraus
  die auffälligen Jobs (länger als 30 Minuten oder mindestens einmal
  zurückgestellt) samt Link auf das Dokument. Titel werden nur für Dokumente
  ausgegeben, die der aufrufende Benutzer sehen darf.

## Bei einem hängenden Job

1. Panel aufklappen → „Hängende Jobs". Grund und Dokument stehen dort.
2. Wiederkehrender Grund `POST …/embed …` → llm-service prüfen
   (`/healthz` antwortet auch dann, wenn `/embed` in den Timeout läuft).
3. Nach dem Beheben: „Fehlgeschlagene wiederholen" oder das Dokument neu
   klassifizieren — beides setzt das Defer-Budget zurück.
