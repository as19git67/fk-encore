# Zähler-Reports — Ausbauplan (Issue #792, Etappe 6)

Ergänzung zu `docs/utility-meters.md` §5. Beschreibt, welche Auswertungen über
den bestehenden Report-MVP hinaus sinnvoll sind, was dafür an Daten und
Annahmen fehlt, und in welcher Reihenfolge das umgesetzt werden sollte.

Status: **Etappen 6a–6d umgesetzt** (Report-Kern, Rollen-Fix, Trend-Dashboard,
PV-Ersparnis/Amortisation, Kosten je Anwendung, Gas-/Benzin-Vergleich + CO₂).
6e offen.

---

## 1. Ist-Stand (was schon da ist)

| Baustein | Ort | Inhalt |
|---|---|---|
| Verbrauchsreihe je Zähler | `GET /meters/:id/report` | Monats-/Jahres-Buckets aus Ableseintervallen, über Gerätewechsel hinweg |
| Aggregierter Energie-Report | `GET /meters/reports/energy` | Bezug, Einspeisung, Produktion, Eigenverbrauch, Autarkie, EV-Quote, WP-/Heizung-/WW-/Wallbox-Aufteilung, PV-Anteile |
| Kostenrechnung | `tariffs.service.ts` | Netzbezugskosten, Grundpreis, Einspeiseerlös, vermiedener Netzbezug, PV-Nutzen, Netto-Stromkosten, `noPvElectricityCostEur` |
| Tarif-Stammdaten | `meter_electricity_tariffs` | Arbeitspreis, Grundpreis, Einspeisevergütung, Eigenverbrauchswert, PV-Invest, Opportunitätskosten, Amortisationsjahre |
| Auswertung im Frontend | `MetersView.vue`, `MeterDetailView.vue` | Mittelwerte, lineare Trendsteigung (nur Bezug + Autarkie), YTD-Vergleich Vorjahr |

Vorhandene Messstellen: Netzstrom Bezug/Einspeisung, PV Produktion, Wärmepumpe
komplett, Fußbodenheizung (+PV), Warmwasser (+PV), E-Auto Wallbox (+PV),
4 Betriebsstundenzähler (Verdichter, Primär-, Heizungs-, Warmwasserpumpe),
Wasser.

### 1.1 Bekannte Lücken im Ist-Stand

> Alle fünf Punkte sind behoben: 1–4 mit Etappe 6a/6b, Punkt 5 (PV-Invest)
> mit 6c.

1. **Wallbox fehlt im Energie-Report.** `ev_charger_total` / `ev_charger_pv`
   sind in `MeterRole`, in `meters_role_check` (Migration 0126) und in
   `reports.service.ts` implementiert, aber `IMPORT_METER_ROLES`
   (`meter/import-electricity-history.ts`) mappt `e_auto_wallbox` /
   `e_auto_pv` nicht, und keine Migration backfilled sie. Die Rolle muss
   heute manuell in der UI gesetzt werden, sonst bleiben alle
   Wallbox-Kennzahlen `null`.
2. **Bucket-Zuordnung ohne Interpolation.** Ein Ableseintervall wird
   vollständig dem Bucket seines *Startzeitpunkts* zugerechnet. Wer am 3.
   und am 5. des Folgemonats abliest, verschiebt den halben Monatsverbrauch.
   Für Jahres-Buckets und für den Vorjahresvergleich verzerrt das spürbar.
3. **Trend nur im Frontend, nur für zwei Kennzahlen.** Die Regression steckt
   in `MetersView.vue` und deckt Bezug + Autarkie ab — nicht Haushaltsstrom,
   Heizung, Warmwasser, Wallbox, Wasser.
4. **Keine Saisonbereinigung.** Rohe Monatswerte einer Heizung sind
   zwischen Januar und Juli nicht vergleichbar; eine Trendgerade über
   12 Rohmonate misst überwiegend die Jahreszeit.
5. **PV-Invest ungenutzt.** `pv_investment_*`, `opportunity_cost_*`,
   `amortization_years` sind gespeichert, fließen aber in keine Rechnung ein.

---

## 2. Report-Ideen

Gruppiert nach Nutzen. Die vom Auftraggeber genannten Wünsche sind mit ⭐
markiert.

### A — PV-Wirtschaftlichkeit

| # | Report | Inhalt | Braucht |
|---|---|---|---|
| A1 ⭐ | **PV-Ersparnis kumuliert** | Kumulierte Kurve „Stromkosten mit PV“ vs. „hypothetische Kosten ohne PV“ seit Inbetriebnahme; Differenzfläche = Ersparnis. Je Bucket bereits als `netElectricityCostEur` / `noPvElectricityCostEur` vorhanden — es fehlt nur Kumulierung + Darstellung. | — |
| A2 ⭐ | **Amortisation** | Invest (netto + MwSt.) minus kumulierter PV-Nutzen → Restbetrag, prognostiziertes Amortisationsdatum aus dem Mittel der letzten 12 Monate. Optional zweite Linie *inkl.* Opportunitätskosten (5 %/a), da beide Werte schon in den Tarifen liegen. | `pv_investment_*`, `opportunity_cost_year` (vorhanden) |
| A3 | **Saisonprofil Autarkie/Eigenverbrauch** | Heatmap Jahr × Monat für Autarkie und Eigenverbrauchsquote. Zeigt sofort, in welchen Monaten der Speicher/die Anlage trägt und ob sich das über die Jahre verbessert. | — |
| A4 | **Ertrag je kWp / Performance-Ratio** | Jahresertrag pro kWp gegen Vorjahre — der einzige belastbare Frühindikator für Anlagendegradation oder verschmutzte Module. | Anlagenleistung kWp (neue Stammdatum-Annahme; wird ohnehin für die korrekte Einspeise-Leistungsstufe gebraucht, siehe `docs/utility-meters.md` §5.2) |

### B — Technologie-Vergleich (kontrafaktisch)

Das sind Modellrechnungen, keine Messungen. Entscheidend ist, dass jede
Annahme sichtbar, datiert und editierbar ist — sonst ist die Zahl wertlos.
Darstellung deshalb immer mit ausklappbarer Annahmen-Box.

| # | Report | Rechenweg | Braucht |
|---|---|---|---|
| B1 ⭐ | **Wärmepumpe vs. Gasheizung** | Wärmemenge = (Heizung + Warmwasser) [kWh el.] × JAZ. Gasbedarf = Wärmemenge ÷ Kesselwirkungsgrad. Gaskosten = Gasbedarf × Gaspreis + Gas-Grundpreis. Gegenüberstellung mit den *tatsächlichen* Stromkosten für Heizung+WW (PV-Anteil zum Eigenverbrauchswert, Netzanteil zum Arbeitspreis). Ausgabe: €/Monat, €/Jahr, kumuliert. | Annahmen: JAZ (bzw. getrennt Heizung/WW), Kesselwirkungsgrad, Gaspreis-Zeitreihe, Gas-Grundpreis |
| B2 ⭐ | **E-Auto vs. Benzin-Pkw** | km = Wallbox-kWh ÷ Verbrauch [kWh/100 km] × 100. Benzinbedarf = km ÷ 100 × [l/100 km]. Kosten Benzin = Liter × Benzinpreis-Zeitreihe. Kosten E-Auto = PV-Anteil × Eigenverbrauchswert + Netzanteil × Arbeitspreis. Ausgabe: €/Monat, €/Jahr, kumuliert, zusätzlich „ct/km“ beider Varianten. | Rollen-Fix (§1.1.1); Annahmen: kWh/100 km, l/100 km, Benzinpreis-Zeitreihe. Optional: Ladeverluste-Faktor |
| B3 | **CO₂-Bilanz** | Vermiedenes CO₂ aus PV (Eigenverbrauch + Einspeisung × Netzmix-Faktor) sowie aus B1/B2 (Erdgas 0,201 kg/kWh, Benzin 2,37 kg/l). Netzbezug mit jahresspezifischem Netzmix. Fällt fast gratis ab, sobald B1/B2 stehen. | Netzmix-Faktor je Jahr (Annahme-Zeitreihe) |
| B4 | **Sanity-Check JAZ aus Betriebsstunden** | Verdichterstunden × geschätzte Leistungsaufnahme gegen tatsächlichen WP-Stromverbrauch — plausibilisiert die für B1 angenommene JAZ, ohne einen Wärmemengenzähler zu haben. Ehrlicherweise nur eine Größenordnung, aber besser als eine ungeprüfte Annahme. | — |

> Hinweis zur Belastbarkeit: B1 steht und fällt mit der JAZ. Ohne
> Wärmemengenzähler ist sie geschätzt; der Report sollte die Ersparnis
> deshalb als **Bandbreite** über JAZ ± 0,5 zeigen statt als eine
> Punktzahl. Gleiches gilt für B2 mit dem Realverbrauch des Verbrenners.

### C — Verbrauchstrends ⭐

Kern des Wunsches: „nehme ich tendenziell mehr oder weniger?“ — je Kennzahl
Haushaltsstrom (ohne Heizung/WW/Wallbox), Heizung, Warmwasser, Wallbox,
Wasser.

| # | Report | Inhalt |
|---|---|---|
| C1 | **Trend-Dashboard** | Eine Kachel je Kennzahl: aktueller 12-Monats-Wert, Änderung ggü. den 12 Monaten davor (absolut + %), Richtungspfeil, Sparkline. Zusätzlich Steigung pro Jahr aus linearer Regression über die **rollierende 12-Monats-Summe** — dadurch ist die Saison herausgerechnet und der Trend tatsächlich lesbar. |
| C2 | **Vorjahresvergleich je Bucket** | `compare=previous_year`: jeder Monat/Jahr bekommt `previousValue`, `deltaAbsolute`, `deltaPercent`. Im Chart als zweite, blassere Linie. Bereits als offener Punkt in `docs/utility-meters.md` §5.1 notiert. |
| C3 | **Witterungsbereinigung Heizung** | Heizverbrauch ÷ Gradtagzahl des Monats. Ohne das ist „mehr Heizstrom als letztes Jahr“ meist nur „kälterer Winter“. Umsetzbar mit einer eingepflegten Gradtagzahl-Tabelle (VDI 2067, Standort-nah) oder — ohne externe Datenquelle — über einen aus den eigenen Daten geschätzten Referenzwinter. |
| C4 | **Ausreißer-Kontext** | Im Trend-Chart die Buckets markieren, die auf ungewöhnlich langen/kurzen Ableseintervallen beruhen (< 20 oder > 40 Tage bei Monatsbuckets). Verhindert Fehlinterpretationen, bevor Etappe 7 (Anomalien) überhaupt existiert. |

### D — Betrieb & Anlagenzustand

| # | Report | Inhalt |
|---|---|---|
| D1 | **kWh je Verdichterstunde** | Stromverbrauch WP ÷ Verdichterstunden, über die Jahre. Steigender Wert = sinkende Effizienz (Vereisung, Kältemittelverlust, verschmutzter Wärmetauscher). |
| D2 | **Laufzeitanteil & Taktung** | Betriebsstunden je Pumpe pro Monat als Auslastung in %; Verdichterstunden pro Heiz-kWh als Taktungsindikator. |
| D3 | **Wasser: Grundlast-Detektor** | Kleinster Tagesverbrauch eines Monats (aus Ableseintervallen abgeleitet). Ein steigender Boden bei sonst gleichem Verbrauch ist das klassische Signal für einen laufenden Spülkasten oder ein Leck. |

### E — Kosten & Finance

| # | Report | Inhalt |
|---|---|---|
| E1 | **Kosten je Anwendung** | Heizung, Warmwasser, Wallbox, Haushalt jeweils in € — PV-Anteil zum Eigenverbrauchswert, Netzanteil zum Arbeitspreis. Beantwortet „was kostet mich das Heizen wirklich“ direkt und ist die Grundlage für B1/B2. |
| E2 | **Wasserkosten** | Analog Strom mit Wasser-/Abwassertarif (Arbeitspreis je m³ + Grundgebühr). |
| E3 | **Abschlag vs. Ist** | Gezahlte Abschläge (Finance) gegen berechnete Ist-Kosten → erwartete Nachzahlung/Erstattung vor der Jahresabrechnung. Setzt Etappe 8 (Finance-Link) voraus. |

---

## 3. Technische Voraussetzungen

### 3.1 Report-Kern (Grundlage für fast alles oben)

- **Interpolation auf Bucket-Grenzen.** Verbrauch eines Ableseintervalls
  linear auf die überlappenden Buckets verteilen statt komplett dem
  Start-Bucket zuzuschlagen. Betrifft `buildMeterReportBuckets`.
  Rückwärtskompatibilität: als Option `allocation=interval_start|interpolated`
  mit `interpolated` als neuem Default, damit sich Zahlen erklärbar ändern.
- **Vorjahresvergleich** (`compare=previous_year`) in `MeterReport` und
  `EnergyReport`.
- **Rollierende 12-Monats-Summe + Trendkennzahlen im Backend**, statt der
  Regression im Frontend. Ergebnis je Kennzahl: `rolling12`, `slopePerYear`,
  `changeVsPreviousYear`, `dataPoints`.
- Optional `granularity=day|week` — für die Bestandsdaten (überwiegend
  monatliche Ablesungen) wenig wert, erst relevant, wenn die
  API-Ingestion regelmäßig liefert. **Empfehlung: zurückstellen.**

### 3.2 Annahmen-Stammdaten

B1/B2/B3 brauchen datierte Annahmen (Gaspreis, Benzinpreis, JAZ,
Kesselwirkungsgrad, kWh/100 km, l/100 km, kWp, Netzmix). Die vorhandene
Tabelle `meter_electricity_tariffs` ist bereits ein generischer
`(kind, valid_from, amount, unit)`-Speicher und enthält mit
`pv_investment_*` / `opportunity_cost_*` schon nicht-tarifliche Werte.

**Empfehlung:** Tabelle wiederverwenden und um neue `kind`s und `unit`s
erweitern (`eur_per_l`, `eur_per_m3`, `kwh_per_100km`, `l_per_100km`,
`ratio`, `kw`, `kg_per_kwh`), in der UI als „Tarife & Annahmen“ mit zwei
Abschnitten führen. Das spart eine Migration samt zweitem CRUD; der Preis
ist ein inhaltlich etwas weiter gefasster Tabellenname.
Alternative wäre eine eigene `meter_assumptions`-Tabelle — sauberer benannt,
aber doppelter Code für dieselbe Semantik.

Jede Modellrechnung liefert die verwendeten Annahmen in der Response mit
(`assumptions: [{ kind, amount, unit, validFrom }]`), damit die UI sie
anzeigen kann und die Zahl nachvollziehbar bleibt.

### 3.3 Rollen-Fix (Blocker für B2)

- `IMPORT_METER_ROLES` um `e_auto_wallbox → ev_charger_total` und
  `e_auto_pv → ev_charger_pv` ergänzen.
- Migration mit Backfill für bereits importierte Bestände (Muster: 0123).
- Test, der sicherstellt, dass jede in `MeterRole` definierte Rolle nach dem
  Import auch tatsächlich vergeben ist — genau diese Lücke ist sonst
  unsichtbar.

---

## 4. Vorgeschlagene Reihenfolge

| Etappe | Inhalt | Warum hier |
|---|---|---|
| **6a** ✅ | Report-Kern: Interpolation, Vorjahresvergleich, Trend-/Rolling-Kennzahlen im Backend + Rollen-Fix | Grundlage; ohne Interpolation und Saisonbereinigung sind alle Trendaussagen unsauber |
| **6b** ✅ | Trend-Dashboard (C1, C2, C4) im Frontend | Der direkt gewünschte Nutzen, sobald 6a steht |
| **6c** ✅ | PV-Ersparnis kumuliert + Amortisation (A1, A2), Kosten je Anwendung (E1) | Nutzt nur vorhandene Tarife, keine neuen Annahmen |
| **6d** ✅ | Annahmen-Stammdaten + Gas- und Benzin-Vergleich (B1, B2), CO₂ (B3) | Braucht 6c (Kosten je Anwendung) als Vergleichsbasis |
| **6e** | Anlagenzustand (D1–D3), Saisonprofil (A3), Ertrag je kWp (A4), Wasserkosten (E2) | Nice-to-have, unabhängig voneinander |
| — | Witterungsbereinigung (C3), Abschlagsvergleich (E3) | C3 nur, wenn eine Gradtagzahl-Quelle akzeptiert wird; E3 hängt an Etappe 8 |

Jede Etappe einzeln testbar und deploybar; `npm run test` vor jedem Push.

---

## 5. Entscheidungen

Getroffen:

1. **Interpolation ist der neue Default** (`allocation=interpolated`), die
   Excel-Logik bleibt als `allocation=interval_start` erreichbar.
2. **Annahmen kommen in `meter_electricity_tariffs`** — die Tabelle wird um
   neue `kind`s und `unit`s erweitert statt eine zweite Tabelle anzulegen
   (§3.2). Umsetzung in 6d.
3. **`granularity=day|week`** ist zurückgestellt, bis die API-Ingestion
   regelmäßig Werte liefert.

Noch offen:

4. **Gradtagzahlen** (C3) — eingepflegte Tabelle, externe Quelle, oder aus den
   eigenen Daten geschätzter Referenzwinter?

Umgesetzt wie vorgeschlagen: die **JAZ-Bandbreite** (± 0,5) statt eines
Punktwerts bei B1.
