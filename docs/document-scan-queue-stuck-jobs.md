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

## Der konkrete Auslöser im Betrieb: CUDA OOM im Embedder

Im Serverlog sah das so aus:

```
fk-encore-llm | INFO: "POST /embed HTTP/1.1" 500 Internal Server Error
fk-encore-llm | torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 192.00 MiB.
                GPU 0 has a total capacity of 15.48 GiB of which 40.69 MiB is free.
fk-encore-app | [ai-queue] documents:embed failed while using embedding slot … after 45ms:
                POST http://llm_service:8000/embed returned 500
```

Der llm-service teilt sich die GPU mit dem llama-server, der seine Gewichte
für seine gesamte Laufzeit resident hält (`nvidia-smi`: 14040 MiB llama-server,
1754 MiB Embedder, ~500 MiB frei auf einer 16-GB-Karte). Für den Encoder
bleibt also kaum Luft — ein Batch aus 32 Chunks à 512 Token passt dort nicht
mehr. Kurze Dokumente gingen durch, die mit vielen Chunks nicht: genau die ein,
zwei Dokumente, die am Ende „wartend" übrig blieben.

Behoben in `llm-service/main.py`:

* `/embed` halbiert bei einem Out-of-Memory die Batch-Größe und probiert es
  erneut (`_encode_with_oom_fallback`). Die Vektoren sind unabhängig davon,
  wie die Texte gruppiert werden — nur der Spitzenbedarf an Aktivierungsspeicher
  ändert sich.
* Die kleinere Batch-Größe bleibt bestehen (`/healthz` →
  `embed_batch_size_effective`); die GPU wird von selbst nicht geräumiger, und
  ein fehlgeschlagener Forward-Pass pro Anfrage wäre reine Verschwendung.
* Passt selbst ein einzelner Text nicht, antwortet der Dienst mit **503**
  („embedder out of memory") statt mit einem 500-Traceback. Beides ist für die
  App eine transiente Störung — der Unterschied ist, dass das Defer-Budget die
  Wiederholungen jetzt begrenzt.
* `LLM_EMBED_BATCH_SIZE` lässt sich vorab realistisch setzen (auf einer
  16-GB-Karte mit 14B-Q4-Modell z. B. `8`), dann entfällt der eine
  fehlgeschlagene Versuch nach jedem Containerstart.

## Bei einem hängenden Job

1. Panel aufklappen → „Hängende Jobs". Grund und Dokument stehen dort.
2. Wiederkehrender Grund `POST …/embed …` → llm-service prüfen. `/healthz`
   antwortet auch dann noch mit `ok`, wenn `/embed` scheitert; bei
   Speicherproblemen zeigt `embed_batch_size_effective` einen Wert unter
   `embed_batch_size`, und `nvidia-smi` zeigt, wie wenig VRAM neben dem
   llama-server frei ist.
3. Nach dem Beheben: „Fehlgeschlagene wiederholen" oder das Dokument neu
   klassifizieren — beides setzt das Defer-Budget zurück.
