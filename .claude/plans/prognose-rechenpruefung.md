# Prognose (Finanzen › Prognose): Prüfung der Rechnungen

Stand: 2026-09-28. Geprüft wurden die Simulation (`finance/forecast-engine.ts`),
die Was-wäre-wenn-Rechnungen (`finance/forecast-analysis.ts`), die Abbildung
der gespeicherten Daten auf die Engine (`finance/forecast.ts`), der
Tabellen-Import (`finance/forecast-import.ts`), das Lesen von Standmitteilungen
und Buchungen (`finance/forecast-statements-extract.ts`,
`finance/forecast-bookings-extract.ts`) und die Anzeige im Frontend
(Kaufkraft-Umrechnung, Prozentfelder, Charts, Dialoge).

Alle Beispiele hier sind erfunden.

Nachtrag: Den einmaligen Tabellen-Import gibt es nicht mehr (entfernt, weil
er nie wieder gebraucht wird). Die Punkte zum Import unten beschreiben, was
beim Prüfen galt; schon importierte Posten tragen weiter die Herkunft
„Excel-Import“.

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

## Nachtrag: Krankenversicherung nach dem Erwerbsleben

Hinweis aus der Nutzung: Das Gehalt ist netto, der Arbeitnehmeranteil steckt
schon drin; interessant wird die KV erst nach dem Ausstieg, und dort hängt
sie davon ab, ob die Vorversicherungszeit für die KVdR erreicht wird.

20. **Erwerbsleben**: „Beitrag bis zum Ausstieg“ ist jetzt standardmäßig 0
    und als Zusatzbeitrag beschrieben; ein Posten „Krankenversicherung“
    kostet im Erwerbsleben nichts, solange nichts eingetragen ist.
21. **Freiwillig gesetzlich** (ohne KVdR): Bemessung aus allen Einnahmen der
    Person — Gehalt, Renten jeder Art, Mieten, Leibrenten — plus dem
    gleichen Anteil an Einnahmen ohne Person (Haushalt) plus den
    Kapitalerträgen des Vormonats (Zinsen, Dividenden, Kursgewinne der
    Töpfe Bargeld/Depot/Sonstiges; eigene Anlagen ganz, Haushaltsanlagen zu
    gleichen Teilen; Immobilien-Wertsteigerung nicht). Gedeckelt an der
    Beitragsbemessungsgrenze (Szenario, wächst mit der Inflation), mindestens
    der Mindestbeitrag. Vorher: nur eigene Einnahmen, keine Kapitalerträge,
    kein Deckel.
22. **KVdR**: gesetzliche Rente mit halbem KV-Satz plus vollem Pflegesatz
    (neues Szenario-Feld „davon Pflegeversicherung“), Betriebsrente voller
    Satz, private Renten und Kapitalerträge beitragsfrei, Deckel an der
    Grenze. Vorher: voller Satz auf alle Renten.
23. Einmalzahlungen (Kapitalwahl, Ablaufleistung) zählen in keiner Variante
    zur Bemessung; in Wirklichkeit würde eine Direktversicherung als
    Versorgungsbezug auf 120 Monate verteilt — nicht modelliert.
24. Der Dokumentleser schlägt für die KV nur noch Beträge vor, die wirklich
    als Prämie gezahlt werden (Zusatzbeitrag, private Tarife); die
    gesetzlichen Modi werden gerechnet.

Vereinfachungen: Bemessung monatlich statt nach Einkommensteuerbescheid des
Vorjahres; kein Sparerpauschbetrag; für die KVdR wird nicht geprüft, ob die
9/10-Regel erfüllt ist — das entscheidet die Wahl des Modus je Person.

## Nachtrag: Hinterbliebenen-Szenario (#1341)

Todesfall als Szenario-Einstellung (Person, Alter), nicht als gespeicherter
Zeitpunkt. Ab dem Geburtsmonat des gewählten Alters: Gehalt, Einnahmen,
Ausgaben, Krankenversicherung, Pflegekosten und eigene Renten der Person
enden; laufende Beiträge in Renten und Lebensversicherungen der Person
enden. Die andere Person erhält den Hinterbliebenen-Anteil der Renten
(Feld am Rentenposten; Standard 55 % gesetzlich, 60 % Betriebsrente, 0 %
privat); bei der gesetzlichen Rente wird eigenes Einkommen des Vormonats
über dem Freibetrag mit dem Anrechnungssatz abgezogen (Standard 40 %,
1 038 €). Lebensversicherungen auf das Leben der Person zahlen die
Todesfallleistung (Feld; leer = garantierte Ablaufleistung) steuerfrei und
enden; eine laufende Leibrente endet. Lebenshaltung × Faktor (Standard
70 %); die Ausgabenkurve folgt der überlebenden Person, wenn die
Bezugsperson stirbt. Ergebnis: Urteil und Kurven wie sonst, dazu der
Vergleich „Ohne Todesfall“ und der Schnellcheck über jedes Sterbealter.

Vereinfachungen: keine Rentenabschläge auf die Witwenrente bei Tod vor 65,
kein Sterbevierteljahr, keine Verteilung einer Direktversicherung; der
Freibetrag gilt pauschal (keine Kinderzuschläge); Erbschaftsteuer nicht
modelliert; die KV-Einstufung der überlebenden Person bleibt, wie am Posten
gewählt (Familienversicherung über die verstorbene Person müsste von Hand
geändert werden).

## Nachtrag: Plan und Wirklichkeit (#1342)

Ein Stand (`finance_forecast_snapshot`) hält die Jahresreihe eines
Szenarios (Vermögen und verfügbares Vermögen je Jahresende) und das
verfügbare Vermögen am Tag der Aufnahme fest — von Hand oder einmal im
Monat per Cron je Szenario. „Erwartet für heute“ ist linear zwischen dem
Startwert und den Jahresenden interpoliert; verglichen wird das
**verfügbare** Vermögen (Bargeld, Depot, Sonstiges: verknüpfte Konten mit
aktuellem Saldo, sonst der eingetragene Wert), weil darauf das Urteil der
Prognose ruht.

Ist-Werte aus den Buchungen der letzten zwölf vollen Monate über alle
Konten des Haushalts: Einnahmen, Ausgaben und Sparrate pro Monat, ohne
Umbuchungen zwischen eigenen Konten (Gegen-IBAN gehört dem Haushalt oder
Spiegelbuchung gleichen Betrags auf einem anderen Konto binnen drei
Tagen). Plan-Ausgaben = Lebenshaltung plus laufende Ausgaben der Posten,
Plan-Sparrate = Einnahmen minus Ausgaben des ersten vollen Simulationsjahres.
„Lebenshaltung übernehmen“ schreibt die Ist-Ausgaben in den einen
Lebenshaltungsposten.

Vereinfachungen: Ausgaben enthalten alles, was abfließt (auch Versicherungs-
beiträge und Sparpläne an fremde Depots ohne Spiegelbuchung); Bargeld-
Abhebungen zählen als Ausgabe; keine Benachrichtigung bei Abweichung.

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
- Krankenversicherung (Details im Nachtrag oben, Punkte 21–23): Bemessung
  monatlich statt nach dem Steuerbescheid des Vorjahres; Kapitalerträge der
  freiwillig Versicherten aus dem Vormonat, ohne Sparerpauschbetrag;
  Einmalzahlungen zählen nicht (die 120-Monats-Verteilung von
  Versorgungsbezügen fehlt); ob die 9/10-Regel für die KVdR erfüllt ist,
  entscheidet die Wahl des Modus je Person.
- Kein Zuschlag bei späterem Rentenbeginn (0,5 %/Monat).
- Die Zeile „Überbrückung gedeckt / nicht gedeckt“ vergleicht Bedarf und
  verfügbares Vermögen am Anfang ohne Erträge in der Phase; das Urteil
  „Geld reicht“ kommt aus der vollen Simulation.
- Sicherheitspuffer ist nominal und wächst nicht mit der Inflation.
- Kontostand eines Depots: Saldo-Zeile vor Positionssumme; ob der FinTS-Saldo
  eines Depots das Verrechnungskonto ist, wäre zu prüfen.
- Zeitleiste: Ziehen eines Datum-Zeitpunkts rechnet in Kalenderjahren.
