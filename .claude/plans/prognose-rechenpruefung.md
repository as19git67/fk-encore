# Prognose (Finanzen › Prognose): Prüfung der Rechnungen

Stand: 2026-09-28. Geprüft wurden die Simulation (`finance/forecast-engine.ts`),
die Was-wäre-wenn-Rechnungen (`finance/forecast-analysis.ts`), die Abbildung
der gespeicherten Daten auf die Engine (`finance/forecast.ts`), der
Tabellen-Import (`finance/forecast-import.ts`), das Lesen von Standmitteilungen
und Buchungen (`finance/forecast-statements-extract.ts`,
`finance/forecast-bookings-extract.ts`) und die Anzeige im Frontend
(Kaufkraft-Umrechnung, Prozentfelder, Charts, Dialoge).

Alle Beispiele hier sind erfunden.

## Behoben (Commit „Forecast: corrections from the calculation audit“)

### Engine

1. **Tagesgeld verzinste sich mit dem Szenario-Zins, steuerfrei.** Ein
   Vermögens-Posten im Topf „Tagesgeld / Konto“ ohne eigene Rendite bekam
   den Standard-Zins (4 %), und Zinsen auf Bargeld wurden nicht besteuert.
   Über 30 Jahre verdreifacht das den Bargeld-Topf. Jetzt: leer = 0 % für
   Bargeld, Standard-Zins nur für Depot/Sonstiges/Immobilie; Zinsen auf
   Bargeld werden wie andere Kapitalerträge pauschal besteuert. Immobilien
   bleiben unbesteuert (Wertsteigerung wird nicht realisiert).
2. **Gesetzliche Rente: Rentenanpassung erst ab Rentenbeginn.** Die
   Renteninformation nennt die Rente in heutigen Werten (aktueller
   Rentenwert, ohne künftige Anpassungen). Die Engine ließ den Betrag bis
   zum Beginn unverändert und wertete erst danach auf; bei 2 % und 10 Jahren
   bis zum Beginn fehlten so 22 % der nominalen Rente. Jetzt wird eine
   gesetzliche Rente ab heute fortgeschrieben; Betriebs- und Privatrenten
   bleiben nominal zum Beginn (so prognostiziert sie die Standmitteilung).
3. **Gesetzliche Rente: früherer Ausstieg senkte die Rente nicht.** Die
   prognostizierte Rente setzt Beiträge bis zur Regelaltersgrenze voraus.
   Wer mit 61 statt 67 aufhört, erwirbt die restlichen Entgeltpunkte nicht.
   Neues Feld „Bisher erreichte Anwartschaft“ (steht in jeder
   Renteninformation): die Rente liegt dann anteilig zu den gearbeiteten
   Monaten zwischen Anwartschaft und Prognose; darauf kommt der Abschlag für
   den früheren Beginn. Ohne das Feld gilt weiter die Prognose. Der
   Standmitteilungs-Leser kennt den Wert jetzt („bisher erreichte
   Rentenanwartschaft“) und schlägt ihn vor.
4. **Rentenbeginn im Geburtsmonat.** Eine gesetzliche Rente beginnt mit dem
   Monat nach dem Geburtsmonat (§ 99 SGB VI); wer am 1. geboren ist, im
   Geburtsmonat. Gilt für den Zeitpunkt „Gesetzliche Rente“ und für die
   Abschlagsrechnung (Monate vor der Regelaltersgrenze).
5. **Regelaltersgrenze pauschal 67.** Neue Personen bekommen sie nach
   Jahrgang (65 bis 1946, steigend, 67 ab 1964; Zwischenmonate auf ganze
   Jahre gerundet).
6. **Kapitalwahl mit 0 € zahlte nichts.** War „Einmalzahlung statt Rente“
   gewählt und der Betrag danach gelöscht, zahlte die Engine 0 € einmalig
   und keine Rente. Jetzt: Einmalzahlung nur bei Betrag > 0; der Dialog
   setzt beim Löschen des Betrags auf Rente zurück.
7. **Sensitivität/Hebel griffen nicht bei Anlagen mit eigener Rendite.** Die
   Rendite-Stufen verschoben nur den Standard-Zins; ein Depot mit eigenen
   5 % blieb unberührt. Jetzt wird jede Anlage außer Bargeld um dieselbe
   Stufe verschoben.
8. Tote Variable `toPots` entfernt (keine Doppelzählung, war ungenutzt).

### Abbildung / Import / Standmitteilungen

9. **Einmalbeträge im laufenden Jahr fielen still weg** (Start „1. Januar“
   lag vor dem Simulationsstart). Jetzt: aktueller Monat.
10. **Abgelaufene Lebensversicherung wurde beim Start noch einmal
    ausgezahlt.** Ablaufjahr in der Vergangenheit wird nicht mehr
    importiert; Ablauf im laufenden Jahr wird als „bitte prüfen“ markiert.
11. **Importierte gesetzliche Renten hingen an festen Daten** und
    reagierten nicht auf den Regler „Gesetzliche Rente“, ohne Abschlag bei
    früherem Beginn. Beim Import werden sie jetzt an den Zeitpunkt der
    Person gebunden, Regelalter = Auszahlungsjahr − Geburtsjahr, Abschlag
    0,3 %/Monat. **Bereits importierte Renten sind davon nicht betroffen**:
    dort „Beginn“ im Dialog auf den Zeitpunkt „Gesetzliche Rente“ stellen
    und Regelaltersgrenze/Abschlag eintragen.
12. Import: Zelle „1“ bei Zinssätzen bedeutet 1 %, nicht 100 %.
13. Krankenversicherung bekam aus Beitragsrechnungen keinen
    Korrekturvorschlag (Buchungen schon). Jetzt: „Beitrag pro Monat“ →
    Beitrag im Erwerbsleben.
14. Ein beitragsfrei gestellter Vertrag („Beitrag 0,00 €“) wurde verworfen;
    0 ist bei Beiträgen jetzt zulässig. Ausgaben ohne Rhythmus zählen als
    monatlich (wie in der Engine). „neuer Beitrag … jährlich“ landet nicht
    mehr als Monatsbeitrag.
15. Girokonten und Bargeld werden als Vermögens-Posten vorgeschlagen (dort
    landet der Monatsüberschuss); ein negativer Kontosaldo ist kein
    Vermögen und wird als 0 gelesen.

### Frontend

16. **KV-Linie im Geldfluss-Chart lag auf den Gesamtausgaben obendrauf**
    (gestapelte Achse ohne eigenen Stapel). Jetzt eigene Stapel.
17. **Ausstiegsalter aus einem Datum** war bei Geburtstag später im Jahr um
    eins zu hoch (Jahresdifferenz statt Alter). Jetzt aus dem Ergebnis der
    Engine. „Aktuelles Alter“ (Haushalt, Regler-Minimum, Zielalter) aus dem
    vollen Geburtsdatum.
18. Puffer-Linie („Sicherheitspuffer“) im Vermögens-Chart bei „heutige
    Kaufkraft“ jetzt deflationiert; Töpfe so gestapelt, dass die Grenze
    über „Sonstiges“ dem verfügbaren Vermögen entspricht.
19. Überbrückung: Deflation nie mit einem Jahr vor dem Start. Prozentfelder
    zeigen 26,375 % statt 26,38 %. Text „mit keinem Alter bis 75“ statt bis
    Endalter. Matrix-Tooltip „Geld geht {Jahr} aus“. Erstes Jahr im Chart
    als Teiljahr gekennzeichnet („2026 (ab Sep.)“). Beschriftung, ab wann
    Steigerung/Anpassung greift.

## Geprüft und in Ordnung

- Kaufkraft: alle Reihen und Detailwerte werden mit ihrem Jahr und demselben
  Startjahr deflationiert; Endvermögen mit dem Endjahr; Matrix ebenso.
- Keine Doppelzählung: Beiträge/Prämien stehen einmal in den Ausgaben;
  Sparpläne sind Umbuchungen Bargeld → Topf und keine Ausgabe.
- Prozent ↔ Bruch in allen Feldern; Abschlag 0,3 % pro Monat × Monate;
  monatliche Verzinsung `(1+r)^(1/12)`; Depotverkauf brutto mit Steuer auf
  den Gewinnanteil; Entnahmereihenfolge; Lebensversicherung linear vom
  Rückkaufswert zur Ablaufleistung, Auszahlung/Rente/Kündigung; KV-Modi;
  Ausgabenkurve und Pflege; Horizont und Jahresabschluss.
- Import: Jahreswerte → Monat, Enden exklusiv, Vorzeichen, Töpfe;
  Standmitteilungs-Vorschläge in der Einheit des Postens; Buchungsrhythmus.

## Bekannte Vereinfachungen (bewusst, dokumentiert)

- Steuern pauschal: Kapitalerträge werden bei Entstehung besteuert
  (konservativ; kein Freibetrag, keine Vorabpauschale); Renten und
  Auszahlungen mit einem festen Satz je Posten; keine Einkommensteuer.
- Freiwillige GKV: Beitrag auf Einnahmen des Monats, Kapitalerträge nicht
  eingerechnet; KVdR: ein Satz auf alle Renten (Betriebsrenten trügen den
  vollen, gesetzliche den halben Satz).
- Kein Zuschlag bei späterem Rentenbeginn (0,5 %/Monat).
- Die Zeile „Überbrückung gedeckt / nicht gedeckt“ vergleicht Bedarf und
  verfügbares Vermögen am Anfang ohne Erträge in der Phase; das Urteil
  „Geld reicht“ kommt aus der vollen Simulation.
- Import ohne Detailblatt: Rückkaufswert 0, garantierte = prognostizierte
  Ablaufleistung (die Engine liest die Garantie nicht).
- Sicherheitspuffer ist nominal und wächst nicht mit der Inflation.
- Kontostand eines Depots: Saldo-Zeile vor Positionssumme; ob der FinTS-Saldo
  eines Depots das Verrechnungskonto ist, wäre zu prüfen.
- Zeitleiste: Ziehen eines Datum-Zeitpunkts rechnet in Kalenderjahren.
