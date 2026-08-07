# Auto-Pick: vom Qualitätsbewerter zum Vergleicher

Konzept, noch nicht umgesetzt. Folgearbeit zu #873 (Focus Peaking) und
`docs/ai-auto-pick.md`.

Grundlage sind drei Messrunden an der produktiven Datenbank
(Stand 2026-08-07, 511 auswertbare reviewte Gruppen):

| Skript | Frage |
|---|---|
| `diagnose-autopick-faces.mjs` | Leidet die Trefferquote unter vielen Gesichtern? |
| `diagnose-autopick-delta.mjs` | Welches Signal erzeugt den Score-Abstand Δ? |
| `diagnose-autopick-calibration.mjs` | Sagt die Größe des Δ die Trefferquote voraus? |

Alle drei sind read-only und jederzeit wiederholbar — siehe
`scripts/photos/README.md`.

## 1. Was gemessen wurde

### Zwei widerlegte Hypothesen

Beide stammen von der Entwicklungsseite und werden hier festgehalten, damit
sie nicht erneut aufgewärmt werden.

**Widerlegt: „`min()` schadet auf Fotos mit vielen Gesichtern."** Die
Trefferquote bleibt über die Gesichtszahl flach (92,5 % / 93,6 % / 93,6 %
bei 1–5 Gesichtern; der Abfall auf 86,8 % bei 6–15 liegt bei n=38 im
Rauschen). σ(face_sharpness) steigt nicht mit der Gesichtszahl.

**Widerlegt: „`face_coverage` erzeugt den Δ."** Tatsächlich dominiert
`face_sharpness` den Δ in allen Konfidenz-Buckets (99 % / 75 % / 64 % des
Median-Δ). Die Vorhersage beruhte auf einem Denkfehler: aus σ(face_sharpness)
≈ 0,035 über *alle* Gruppen wurde geschlossen, das Signal könne bei Gewicht
0,40 keinen Δ von 0,10 erzeugen. Die `high`-Gruppen sind aber genau die
Teilmenge mit großem Δ — ein Auswahleffekt. Wer den unbedingten Mittelwert
auf die Bedingung anwendet, die ihn erzeugt, rechnet sich in die Irre.

### Der belastbare Befund

**Innerhalb einer Ähnlichkeitsgruppe unterscheidet fast nichts.** Beiträge
zum Δ in den `high`-Gruppen:

| Signal | Median-Beitrag |
|---|---|
| `face_sharpness` | 0,1649 (99 %) |
| `eyes_open` | 0,0097 |
| `clip_aesthetics` | **0,0000** (Mittel −0,0007) |
| `blur` | **0,0000** |

Ästhetik und globale Schärfe tragen exakt nichts zur Unterscheidung bei.
Das ist keine Überraschung, sondern Definition: ähnliche Bilder haben
ähnliche Ästhetik. σ(blur) innerhalb der Gruppen liegt bei 0,000.

**Der Δ ist nicht monoton mit der Trefferwahrscheinlichkeit.** Lift über
einer hypergeometrischen Zufallsbasislinie:

| Δ-Bereich | Gruppen | Lift |
|---|---|---|
| 0,00–0,02 | 337 | +0,0 pp |
| 0,02–0,04 | 12 | +6,7 pp |
| 0,04–0,06 | 18 | +18,9 pp |
| 0,06–0,10 | 58 | **+25,2 pp** |
| 0,10–0,15 ← ab hier `high` | 28 | +11,9 pp |
| 0,15–0,25 | 36 | +5,7 pp |
| 0,25+ | 22 | +6,1 pp |

Umgekehrt U-förmig, in einer zweiten Stichprobe (nur exakt reproduzierbare
Scores, n=301) reproduziert. Nach Konfidenz-Bucket:

| Bucket | Trefferquote | Lift | Verhalten |
|---|---|---|---|
| `low` | 96,8 % | +0,2 pp | nichts |
| `medium` | 90,8 % | **+23,7 pp** | nur Marker |
| `high` | 75,6 % | +7,8 pp | **blendet ungefragt aus** |

Der einzige Bucket, der automatisch ausblendet, ist der zweitschlechteste.
Der beste zeigt bloß einen Marker.

**In zwei Dritteln der Fälle entscheidet das Modell gar nicht.** 337 der 511
Gruppen liegen bei Δ≈0. Dort greift Multi-Pick (`MULTI_PICK_THRESHOLD` 0,92)
und wählt im Schnitt 2,33 von 2,3 Mitgliedern — also praktisch alle. Ein
Treffer ist damit garantiert, die Basislinie ebenso hoch, der Lift null. Das
ist keine Fehlentscheidung, sondern eine **Enthaltung**.

## 2. Die strukturelle Diagnose

> Das Modell ist ein **absoluter Qualitätsbewerter**, wird aber als
> **Vergleicher innerhalb einer Gruppe** eingesetzt.

Rund 0,85 des Gewichts liegt auf Signalen, die innerhalb einer Gruppe
konstant sind. Sie heben den absoluten Score, tragen zur Rangfolge aber
nichts bei. Das ist kein Tuning-Problem, sondern ein Konstruktionsfehler: es
wird gemessen, was ein Bild gut macht, statt was die Bilder *voneinander*
unterscheidet.

Daraus folgen alle drei Symptome:

- **Der Δ taugt nicht als Konfidenz.** Variiert faktisch nur ein Signal, ist
  Δ im Kern „wie stark hat dieses eine Signal geschwankt". Ein sehr großer Δ
  ist dann eher ein Ausreißer in einem `min()`-aggregierten, rauschanfälligen
  Signal als ein echter Qualitätsunterschied — daher der Abfall des Lifts bei
  großem Δ.
- **Die Kalibrierung kann nicht greifen** (0,608 gegen Baseline 0,590). Die
  paarweise Regression hat die richtige Form — sie lernt auf
  Signal*differenzen*. Aber es lassen sich keine unterscheidenden Gewichte
  lernen, wenn die Merkmale nicht variieren.
- **Die hohe Enthaltungsquote.** Ohne variierende Merkmale liegen die Scores
  dicht beieinander, Multi-Pick greift, es wird nicht entschieden.

### Warum `min()` die Varianz nicht nur verrauscht, sondern *löscht*

Ein Mechanismus, der bisher untergegangen ist und die Enthaltungsquote
erklärt: `face_sharpness` ist das Minimum über alle Detektionen. Ist das
unschärfste Gesicht durchgängig dasselbe winzige Hintergrundgesicht — und
das ist bei kleinen Gesichtern der Regelfall, weil sie physikalisch immer am
unschärfsten sind — dann ist das Minimum über alle Frames eines Bursts
**identisch**. Die Schärfe des Hauptmotivs, die zwischen den Aufnahmen
durchaus schwankt, wird vom konstanten Minimum vollständig maskiert.

Die Varianz ist also in den Pixeln vorhanden, wird aber von der Aggregation
weggeworfen, bevor sie das Scoring erreicht. Das ist die konkrete Erklärung
dafür, warum so viele Gruppen bei Δ≈0 landen — und zugleich die begründete
Erwartung, dass eine prominenzgewichtete Aggregation sie freilegt.

## 3. Zielbild: zwei Regime

Vom Nutzer formuliert und durch die Messung gestützt:

**Regime A — Gesichter prominent.** Man schaut genauer hin. Es entscheiden
Gesichtsdetails: Schärfe des *relevanten* Gesichts, Augen offen,
Blickrichtung. Alles Übrige ist innerhalb der Gruppe konstant.

**Regime B — Gesichter klein oder keine.** Hier variieren tatsächlich
Ausschnitt, Belichtung, Moment; die vorhandenen Signale können etwas leisten.

Der heutige Binärschalter `face_count > 0` ist eine kaputte Näherung genau
dieser Unterscheidung — eine einzelne Fehldetektion im Hintergrund schiebt
ein Landschaftsfoto in Regime A und wirft dabei `clip_composition` und
`clip_technical` aus der Bewertung. Prominenz beantwortet nicht nur „welche
Gesichter soll ich messen", sondern die vorgelagerte Frage: **in welchem
Regime befindet sich diese Gruppe?**

### Relevanzgewicht

```
w(face) = prominence(face) · identity_bonus(face)
```

Prominenz (bbox-Fläche, mit Untergrenze) ist das primäre Kriterium — dieselbe
Erkenntnis wie bei Focus Peaking (`MIN_RENDERED_FACE_PX`): ein 15-px-Gesicht
ist nicht beurteilbar, egal wem es gehört.

Identität wirkt **nur als Bonus, nie als Strafe**: zugeordnete Personen
`1 + KNOWN_BONUS`, alle anderen `1` — auch explizit ignorierte.

### Warum ignorierte Gesichter *nicht* ausgeschlossen werden

Das Flag `ignored` vermischt zwei in der Datenbank nicht unterscheidbare
Aussagen (beide `ignored = TRUE, person_id = NULL`):

1. „Das ist gar kein Gesicht" — Fehldetektion.
2. „Das ist ein Gesicht, aber ein Fremder, der nicht in meinen Personenindex
   gehört."

Für Fall 2 gilt: ein scharf abgebildeter Fremder ist immer noch scharf. Ein
Bild mit fünf scharfen Personen ist besser als eines mit drei scharfen und
zwei verwackelten — unabhängig davon, ob man sie kennt. Fehldetektionen
werden über die **Prominenz** ausgesiebt, nicht über das Flag; das erwischt
auch die, die nie jemand ignoriert hat.

Geschrieben wird das Flag ausschließlich durch explizite Nutzeraktionen
(`ignoreFaceLogic`, `ignorePersonFacesLogic`) — es ist verlässlich
Nutzerabsicht, aber eine über *Personenverwaltung*, nicht über
*Bildqualität*.

### Warum ein Identitätsbonus unbedenklich ist

Der Score wird ausschließlich *innerhalb* einer Ähnlichkeitsgruppe
verglichen, nie über die Bibliothek hinweg. Eine systematische Anhebung von
Personenfotos verzerrt also keine Rangfolge zwischen Landschaft und Porträt —
sie wirkt nur dort, wo zwei Aufnahmen derselben Szene gegeneinander stehen.

## 4. Datenlage

| Daten | vorhanden? |
|---|---|
| bbox je Gesicht | **ja** (`faces.bbox`) |
| Personenzuordnung / ignoriert | **ja** (`user_face_assignments`) |
| Schärfe **je Gesicht** | **nein** — nur das Minimum |
| Augen offen **je Gesicht** | **nein** — nur das Minimum |
| Blickrichtung | **nein** — aber siehe unten |

`faces.quality` existiert, wird beim Insert konstant auf `100` gesetzt und
trägt keine Information.

**Blickrichtung ist billiger als erwartet.** Der InsightFace-Service liefert
in `/detect` bereits `kps` mit — fünf Landmarken je Gesicht (Augenmitten,
Nasenspitze, Mundwinkel). Im Photo-Service kommt `kps` kein einziges Mal vor;
die Daten werden verworfen. Kopfdrehung und -neigung lassen sich daraus
geometrisch ableiten (Nasenversatz gegenüber der Augenlinie → Gierwinkel,
Neigung der Augenlinie → Rollwinkel). Kein neues Modell, sondern
Persistierung plus erneute Detektion.

**Augenöffnung geht damit nicht.** Fünf Landmarken geben Augen*mitten*, keine
Lidkonturen. Dafür bräuchte es weiter CLIP je Ausschnitt oder ein
68-Punkte-Modell — die teuerste der drei Optionen.

Schärfe je Gesicht braucht einen Backfill, aber einen billigen: die
Laplace-Varianz über einen bbox-Ausschnitt ist reine Pixelarithmetik. Kein
CLIP, keine GPU. Die Formel existiert bereits unit-getestet in
`frontend/src/utils/focusPeaking.ts` und müsste serverseitig mit `sharp`
gespiegelt werden.

## 5. Das Ziel, präzise

Zwei Dinge, in dieser Reihenfolge.

### Ziel 1: Das Entscheidungsband verbreitern

Heute entscheidet das Modell nur in einem schmalen Bereich sinnvoll —
Δ ∈ [0,04; 0,15], das sind 86 von 511 Gruppen (17 %). In 66 % enthält es
sich (Multi-Pick), darüber wird es unzuverlässig.

„Verbreitern" heißt: **die Enthaltungsquote senken, ohne die Trefferquote zu
verschlechtern.** Drei Hebel, in aufsteigendem Aufwand:

1. **Vorhandene Varianz freilegen** — prominenzgewichtete Aggregation statt
   `min()`. Nach Abschnitt 2 ist die Schärfevarianz des Hauptmotivs bereits
   in den Daten, wird aber vom konstanten Minimum maskiert. Dies ist der
   Hebel mit dem besten Verhältnis von Aufwand zu Wirkung.
2. **Signale ergänzen, die per Konstruktion variieren** — Blickrichtung, und
   perspektivisch Augenzustand je Gesicht. Zwischen zwei Aufnahmen eines
   Bursts ändern sich genau diese Dinge: Menschen bewegen sich, blinzeln,
   drehen den Kopf. Es sind zugleich die, nach denen der Nutzer tatsächlich
   entscheidet.
3. **Gruppenrelativ statt absolut rechnen.** Nicht die absolute
   Signaldifferenz gewichten, sondern ihr Verhältnis zur Streuung *dieses
   Signals in dieser Gruppe*. Eine Differenz von 0,02 in einem Signal, das
   sonst felsenfest liegt, ist aussagekräftiger als 0,10 in einem, das in
   dieser Gruppe ohnehin springt. Reine Algorithmusänderung, keine neuen
   Daten — und der direkte Angriff auf „Δ misst nicht, was es vorgibt".

Messgröße für den Erfolg: Anteil der Gruppen mit belegtem Lift, gegen die
Trefferquote gehalten. Nicht „höherer Score", sondern „öfter eine
Entscheidung, die trägt".

### Ziel 2: Das Auto-Ausblenden ehrlich machen

Heute behauptet das System Sicherheit („high") auf Basis eines
Score-Abstands, von dem gemessen ist, dass er oberhalb 0,10 nicht mit
Richtigkeit korreliert. Das ist der Kern des Problems — nicht die Höhe der
Schwelle.

Der Leitsatz dazu:

> **Vertrauen wird gemessen, nicht behauptet.**

Konkret: die Konfidenz-Einstufung wird nicht mehr aus dem Score-Abstand
abgeleitet, sondern aus der **an den eigenen Reviews gemessenen
Trefferquote** des jeweiligen Bereichs. Das System darf genau dann
automatisch ausblenden, wenn es sich diese Erlaubnis auf den Daten dieses
Nutzers verdient hat — belegt durch Lift und Trefferquote oberhalb einer
festgelegten Schranke. Erreicht kein Bereich diese Schranke, bleibt das
Auto-Ausblenden **aus**, und das System beschränkt sich auf den Marker.

Bemerkenswert: die Maschinerie dafür existiert bereits. Der
Bulk-Accept-Dialog zeigt dem Nutzer schon heute seine Übereinstimmungsquote —
sie ist nur nicht mit der Entscheidung verknüpft, ob überhaupt ausgeblendet
werden darf. Und `diagnose-autopick-calibration.mjs` misst genau die Größe,
die dafür gebraucht wird.

Ein naheliegender, aber verworfener Kurzschluss: „dann setze `high` eben auf
das Intervall mit dem besten Lift (0,04–0,15)". Das wäre eine
Kurvenanpassung an n=86 und zudem kaum erklärbar („bei mittlerem Abstand
blenden wir aus, bei großem nicht"). Die Ursache des Abfalls bei großem Δ ist
nicht verstanden — solange sie es nicht ist, ist Zurückhaltung die ehrlichere
Antwort als eine an die Kurve angepasste Schwelle.

**Was nicht das Ziel ist:** ein System, das die Auswahl abnimmt. Der
Gesamt-Lift liegt bei +5,0 pp, im besten Bereich bei +25 pp. Realistisch ist
eine gute Vorsortierung mit ehrlicher Selbstauskunft darüber, wie sicher sie
ist — nicht Automatisierung des Aussortierens.

## 6. Etappen

**Sofort, ohne Abhängigkeit: Auto-Ausblenden bei `high` abschalten** (oder
hinter eine Bestätigung je Gruppe legen). Datenbelegt: 75,6 % Trefferquote
bei +7,8 pp Lift, während `medium` ohne jedes Ausblenden +23,7 pp liefert.
Produktentscheidung, technisch trivial.

**Etappe 1 — Prominenz aus bbox.** Relevanzgewicht, gleitender
Regime-Übergang statt `face_count > 0`, `face_coverage` nur über prominente
Gesichter, Anwesenheit bekannter Personen als schwaches Signal. Kein
Re-Scan nötig, vollständig offline validierbar.

**Etappe 2 — Schärfe je Gesicht.** Neue Spalte `faces.sharpness`, gefüllt per
Hintergrund-Job analog zum Dimensions-Backfill. Erst damit wird das
eigentliche Kriterium messbar: „die Aufnahme, auf der das Gesicht der
bekannten Person scharf ist". Nebeneffekt: Focus Peaking im Frontend könnte
die Werte lesen, statt sie bei jedem Betrachten neu zu berechnen.

**Etappe 3 — `kps` persistieren → Blickrichtung.** Erneute Detektion nötig,
aber kein neues Modell.

**Etappe 4 — Gruppenrelative Normalisierung.** Reine Algorithmusänderung,
kann jederzeit dazwischen; sinnvoll erst, wenn mehrere variierende Signale
vorliegen.

**Etappe 5 — Augen offen je Gesicht.** Teuerste Option, nur falls die
Messung zeigt, dass es sich lohnt.

## 7. Validierung: Offline-Replay als Pflicht, nicht als Kür

Zwei Hypothesen sind in diesem Projekt bereits an den Daten gescheitert. Für
jede weitere Änderung gilt daher: **keine Formeländerung ohne vorherige
Messung am historischen Bestand.**

Die reviewten Gruppen sind ein fertiges Testset — Gruppe, gespeicherte
Signale, tatsächliche Nutzerentscheidung. Zu messen ist alt gegen neu:

- Trefferquote und **Lift** gesamt (Lift, nicht Quote — sonst vergleicht man
  unterschiedlich schwere Gruppen)
- Lift je Δ-Bin: wird die Kurve monoton?
- Enthaltungsquote: sinkt der Anteil der Δ≈0-Gruppen?
- Anzahl Gruppen mit geändertem Pick (Bewegungsmaß)

Schwellwerte (`PROMINENCE_SATURATION`, Untergrenze, `KNOWN_BONUS`) werden
**nicht geraten**, sondern über den Replay bestimmt.

### Prüfbare Vorhersagen

Explizit formuliert, damit sie widerlegbar sind:

- **V1:** Prominenzgewichtete Schärfe hat eine höhere Streuung innerhalb der
  Gruppe als das heutige Minimum. *Prüfbar direkt nach dem Backfill in
  Etappe 2, vor jeder Formeländerung.* Trifft V1 nicht zu, ist die
  Kernannahme aus Abschnitt 2 falsch und Etappe 2 zwecklos.
- **V2:** Ein erheblicher Teil der heutigen Δ≈0-Gruppen erhält einen von null
  verschiedenen Δ. *Offline prüfbar.*
- **V3:** Die Lift-Kurve über Δ verliert ihren Abfall bei großem Δ.
  *Offline prüfbar.*

V1 ist die billigste und zugleich schärfste Prüfung — sie entscheidet über
Etappe 2, bevor irgendetwas am Scoring angefasst wird.

## 8. Offene Punkte

- **Die Ursache des Lift-Abfalls bei großem Δ ist nicht verstanden.** Die
  Artefakt-Vermutung (Extremwert in einem rauschanfälligen Minimum) ist
  plausibel, aber ungeprüft. Ein Filter auf die 22 Gruppen mit Δ ≥ 0,25 in
  `diagnose-autopick-delta.mjs` würde es zeigen.
- **Selektionseffekt:** reviewte `high`-Gruppen sind keine Zufallsstichprobe.
  Der Replay erbt das, verzerrt den Vergleich alt/neu aber nicht, solange
  beide auf demselben Testset laufen.
- **Reproduzierbarkeit:** nur 58,2 % der gespeicherten Scores lassen sich mit
  den heutigen Gewichten exakt nachrechnen — ältere Gruppen tragen Scores
  früherer Formelversionen. Die Kernbefunde wurden auf der reproduzierbaren
  Teilmenge gegengeprüft und blieben bestehen.
- **Bestehende Picks** ändern sich durch eine neue Formel. Reviewte Gruppen
  werden nicht mehr angefasst, betroffen sind nur offene — sichtbar bewegt
  sich für den Nutzer trotzdem etwas.
