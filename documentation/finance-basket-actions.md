# Finance — Basket-Aktionen

Status: umgesetzt in Epic #722.

Dieses Dokument beschreibt die erweiterten Aktionen im Finance-Basket. Der
Basket ist die temporäre Auswahl von Transaktionen in der Finance-UI.

---

## UI-Verhalten

Die Basket-Aktionen werden im Drawer `TxBasketIndicator` angeboten. Aktionen,
die vor dem Anzeigen Daten laden (`Baskets`), öffnen ihren
Dialog sofort und laden Inhalte anschließend nach. Fehler werden im jeweiligen
Dialog angezeigt, damit ein Klick nicht „tot“ wirkt.

Auf schmalen Viewports sind die Aktionen kompakt angeordnet, damit die
Transaktionsliste nicht vollständig verdrängt wird.

### Live-Sync mit der Transaktionsliste

Basket-Aktionen, die Buchungsfelder ändern (Prüfvermerk, Steuerrelevanz,
Gegenseiten-Vereinheitlichung, Tags, Notiz), schreiben das Ergebnis nicht nur
in den Basket-Store zurück, sondern spiegeln es über
`useTransactionsStore.syncFrom()` / `.patch()` auch in die aktuell
angezeigte Liste. Dadurch zeigt die Liste die Änderung sofort an, ohne dass
der Nutzer neu laden muss (#886).

`syncFrom`/`patch` sind No-ops für IDs, die nicht auf der aktuell geladenen
Seite liegen — eine Änderung an einer Buchung außerhalb des aktiven
Filters/Scopes schleust sich also nicht versehentlich in die Liste ein.
`TransactionDetailView.save()` folgt demselben Muster für Einzel-Edits.

Die Batch-Notiz-Aktion ist ein Sonderfall: `POST
/finance/transactions/batch-notice` liefert nur Zähler zurück, keine
aktualisierten Buchungen. Das Frontend repliziert deshalb die
Replace/Append-Regel des Servers lokal (`BatchNoticeDialog` gibt Text +
Modus im `applied`-Event mit), statt die Buchungen erneut zu laden.

---

## Split

`Split` teilt eine einzelne Bankbuchung logisch in mehrere Teile auf. Die
Aktion sitzt in der Transaktions-Detailansicht (`SplitTransactionDialog`),
nicht mehr im Basket: eine Aufteilung betrifft immer genau eine Buchung.

Die Originalbuchung bleibt unverändert in `finance_transaction`. Die
Aufteilung wird als Overlay in `finance_transaction_split` gespeichert:

- `transaction_id`: Referenz auf die Originalbuchung, `ON DELETE CASCADE`
- `amount`: Teilbetrag
- `tags`: JSON-Array von Tag-Namen
- `notice`: optionale Notiz pro Teil
- `is_tax_relevant`: Steuerrelevant-Flag pro Teil

Beim Speichern werden bestehende Split-Zeilen dieser Buchung vollständig
ersetzt. Die Summe aller Teile muss centgenau dem Betrag der Originalbuchung
entsprechen.

API:

- `GET /finance/transaction-splits?id=…`
- `PUT /finance/transaction-splits?id=…`

Die älteren typed Endpunkte bleiben backendseitig kompatibel:

- `GET /finance/transactions/:transactionId/splits`
- `PUT /finance/transactions/:transactionId/splits`

Das Frontend verwendet die raw JSON-Endpunkte mit statischem Pfad, analog zu
den Basket-Snapshot-Endpunkten. Dadurch vermeiden wir Browser-/Runtime-Probleme
mit Path-Param-Pattern-Decoding und typed API Encoding.

Beträge werden im Dialog ohne Vorzeichen eingegeben; das Vorzeichen der
Ausgangsbuchung wird beim Speichern angewendet. Dezimal- und Tausendertrenner
folgen der UI-Locale (`utils/financeSplit.ts`).

---

## Steuerrelevanz

Es gibt zwei unabhängige Flags:

- `finance_transaction.is_tax_relevant` — die Buchung als Ganzes. Setzbar
  über die Basket-Aktion `Steuerrelevant`
  (`POST /finance/transactions/batch-tax-relevant`) oder einzeln über den
  Schalter in der Detailansicht, der denselben Endpunkt mit einer ID aufruft.
- `finance_transaction_split.is_tax_relevant` — pro Teilbetrag, gesetzt im
  Split-Dialog.

`GET /finance/transactions` filtert über `taxRelevant`:

- `taxRelevant=true` → Buchungen, die selbst markiert sind **oder**
  mindestens einen markierten Teilbetrag haben
- `taxRelevant=false` → Buchungen, auf die beides nicht zutrifft
- weggelassen → kein Filter

Damit die gefilterte Liste erkennbar bleibt, liefert jede Buchung zusätzlich
`has_tax_relevant_split`; die Liste zeigt entsprechend „Steuerrelevant“ bzw.
„Teilbetrag steuerrelevant“ an.

---

## Benannte Baskets

`Baskets` speichert die aktuelle Transaktionsauswahl unter einem Namen. Ein
gespeicherter Basket kann später geladen, gelöscht oder mit einem anderen
Basket verglichen werden.

Die Persistenz liegt in `finance_basket_snapshot`:

- `user_id`: Besitzer des gespeicherten Baskets
- `name`: Name, pro User eindeutig
- `tx_ids`: Array der Transaktions-IDs

Beim Laden werden nicht mehr zugreifbare oder gelöschte Transaktionen
übersprungen; die Response enthält `missing`.

Frontend-Pfade verwenden absichtlich raw JSON-Endpunkte mit statischen Pfaden,
um Probleme mit typed API Encoding/Decoding und Browser-Pattern-Fehlern zu
vermeiden:

- `GET /finance/basket-snapshots`
- `POST /finance/basket-snapshots`
- `GET /finance/basket-snapshot?id=…`
- `DELETE /finance/basket-snapshot?id=…`

Die älteren typed Endpunkte bleiben backendseitig kompatibel:

- `GET /finance/baskets`
- `POST /finance/baskets`
- `GET /finance/baskets/:id`
- `DELETE /finance/baskets/:id`

Alle Basket-Responses werden als JSON-sichere DTOs normalisiert, insbesondere
`BIGINT`-Felder wie `id` und `tx_ids`.
