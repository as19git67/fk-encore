# Auto-Pick: Gesichter nach Relevanz gewichten

Konzept, noch nicht umgesetzt. Folgearbeit zu #873 (Focus Peaking) und
`docs/ai-auto-pick.md`. Grundlage sind Messungen an der produktiven
Datenbank via `scripts/photos/diagnose-autopick-faces.mjs`
(Stand 2026-08-07, ~380 reviewte Gruppen mit gespeichertem Pick).

## 1. Was die Messung ergeben hat

Die ursprüngliche Vermutung — die `min()`-Aggregation von `face_sharpness`
verschlechtere die Vorschläge auf Fotos mit vielen Gesichtern — ist
**widerlegt**. Die Trefferquote bleibt über die Gesichtszahl hinweg flach
(92,5 % / 93,6 % / 93,6 % bei 1–5 Gesichtern; der Abfall auf 86,8 % bei
6–15 liegt bei n=38 im Rauschen), und σ(face_sharpness) steigt nicht mit
der Gesichtszahl.

Stattdessen zeigen die Daten drei andere Dinge:

**a) Das Konfidenz-Gate ist invertiert.**

| | Gruppen | Trefferquote |
|---|---|---|
| `ai_picked_confidence = 'high'` | 83 | **75,9 %** |
| alles andere | 298 | **97,3 %** |

Konsistent in jedem Gesichts-Bucket. Δ — der Score-Abstand, der Sicherheit
ausdrücken soll — ist anti-prädiktiv. Und genau dieser Bucket wird von
`bulkAcceptHighConfidencePicksLogic` ungefragt angewendet.

*Vorbehalt:* reviewte high-Gruppen sind keine Zufallsstichprobe. Werden
bevorzugt jene geöffnet, bei denen das automatische Ausblenden auffiel, ist
der Bucket mit Fehlern angereichert. Die 21 Punkte sind eine Obergrenze,
der Effekt aber zu groß, um Selektion allein zu sein.

**b) Der Δ kommt nicht aus der Schärfe.** σ(face_sharpness) liegt innerhalb
einer Gruppe bei ~0,035. Mit Gewicht 0,40 sind das ~0,014–0,02 Beitrag zum
Score-Abstand — die Schwelle für `high` liegt bei 0,10. σ(blur) ist mit
0,000 noch flacher. Das höchstgewichtete Signal des Face-Zweigs kann den
Abstand, der das Auto-Ausblenden auslöst, gar nicht erzeugen. Übrig bleiben
`eyes_open` (0,20), `face_coverage` (0,15), `face_composition` (0,10).
`face_coverage` ist die **Summe über alle Detektionen** und springt, sobald
der Detektor zwischen zwei Frames unterschiedlich viele Gesichter findet —
der wahrscheinlichste Kandidat, und noch nicht gemessen (siehe Etappe 0).

**c) Der Zweig-Umschalter greift zu oft.** 71,9 % der Fotos im Face-Zweig
haben ihr größtes Gesicht auf unter 2 % der Bildfläche, 34,4 % unter 0,5 %.
Sie werden nach der Porträt-Formel bewertet — `clip_composition` und
`clip_technical` fallen dabei komplett weg.

Ergänzend: die Kalibrierung bringt kaum etwas (Face 0,608 gegen Baseline
0,590; Non-Face 0,649 gegen Baseline 0,669 — schlechter als die Baseline).

## 2. Die zwei Denkfehler im heutigen Modell

**Binär statt graduell.** `face_count > 0` schaltet zwischen zwei völlig
verschiedenen Formeln um. Eine einzige Fehldetektion im Hintergrund
entscheidet, ob ein Foto nach Porträt- oder nach Landschaftsregeln bewertet
wird. Es gibt kein Dazwischen.

**Alle Gesichter zählen gleich.** `min()` über sämtliche Detektionen behandelt
den Passanten in 30 m Entfernung wie das Hauptmotiv. Das Modell hat keinen
Begriff von *Prominenz* — und keinen von *Identität*: in
`group-auto-pick.ts`, `group-auto-pick.service.ts` und
`group-auto-pick.calibration.ts` kommt „person" kein einziges Mal vor. Ob
auf einem Foto jemand ist, der dem Nutzer wichtig ist, geht in die
Bewertung nicht ein.

### Was `ignored` **nicht** bedeutet

Naheliegend wäre, ignorierte Gesichter (17.070 auf 8.717 Fotos) einfach aus
dem Scoring zu nehmen. Das wäre falsch. Das Flag vermischt zwei Aussagen,
die in der Datenbank nicht unterscheidbar sind (beide:
`ignored = TRUE, person_id = NULL`):

1. „Das ist gar kein Gesicht" — Fehldetektion.
2. „Das ist ein Gesicht, aber ein Fremder, der nicht in meinen
   Personenindex gehört."

Für Fall 2 gilt: ein scharf abgebildeter Fremder ist immer noch scharf. Ein
Bild mit fünf scharfen Personen ist besser als eines mit drei scharfen und
zwei verwackelten — unabhängig davon, ob man sie kennt. Ausschluss würde
echte Qualitätsinformation vernichten.

Geschrieben wird das Flag ausschließlich durch explizite Nutzeraktionen
(`ignoreFaceLogic`, `ignorePersonFacesLogic` in `photo.service.ts`); kein
automatischer Pfad setzt es. Es ist also verlässlich Nutzerabsicht — nur
eben eine über *Personenverwaltung*, nicht über *Bildqualität*.

## 3. Leitidee: Relevanz statt Binärschalter

Jedes erkannte Gesicht bekommt ein **Relevanzgewicht** `w ∈ [0, 1]`. Alle
Gesichtssignale werden damit gewichtet, statt blind über alle Detektionen
zu minimieren. Der Zweig-Umschalter wird durch einen gleitenden Übergang
ersetzt.

```
w(face) = prominence(face) · identity_bonus(face)
```

**Prominenz ist das primäre Kriterium**, nicht der Ignoriert-Status. Das ist
dieselbe Erkenntnis, die Focus Peaking sichtbar gemacht hat
(`MIN_RENDERED_FACE_PX`): ein 15-px-Gesicht im Hintergrund ist nicht
beurteilbar — egal wem es gehört.

```
prominence = clamp01( (bbox_area / PROMINENCE_SATURATION) ^ γ )
```

mit einer Untergrenze, unterhalb derer `w = 0` (nicht beurteilbar, und
zugleich der Bereich, in dem Fehldetektionen dominieren).

**Identität wirkt nur als Bonus, nie als Strafe.** Zugeordnete Personen
zählen mehr, aber niemand zählt weniger als seine Prominenz hergibt:

| Zustand | `identity_bonus` |
|---|---|
| einer Person zugeordnet | `1 + KNOWN_BONUS` |
| nicht zugeordnet | `1` |
| explizit ignoriert | `1` (bewusst keine Strafe, siehe 2.) |

Damit bleibt das Argument aus 2. gewahrt: Fremde tragen weiter zur
Qualitätsbewertung bei, bekannte Personen bekommen zusätzliches Gewicht.
Fehldetektionen werden nicht über das Flag ausgesiebt, sondern über die
Prominenz — was auch die Fälle erwischt, die nie jemand ignoriert hat.

**Warum ein Identitätsbonus unbedenklich ist:** der Score wird
ausschließlich *innerhalb* einer Ähnlichkeitsgruppe verglichen
(`computeGroupPick`), nie über die Bibliothek hinweg. Eine systematische
Anhebung von Personenfotos verzerrt also keine Rangfolge zwischen
Landschaft und Porträt — sie wirkt nur dort, wo zwei Aufnahmen derselben
Szene gegeneinander stehen. Genau da ist sie gewollt.

## 4. Was sich je Signal ändert

| Signal | heute | neu |
|---|---|---|
| `face_sharpness` (0,40) | `min()` über alle Gesichter | relevanzgewichtetes Mittel, plus Straftterm für das schlechteste *prominente* Gesicht |
| `eyes_open` (0,20) | `min()` über alle Gesichter | `min()` nur über prominente Gesichter |
| `face_coverage` (0,15) | Summe **aller** bbox-Flächen | Summe nur der prominenten |
| Zweig-Umschalter | `face_count > 0` | gleitend über prominente Gesamtabdeckung |
| — | *existiert nicht* | neues Signal: bekannte Person prominent **und** scharf |

Zu `eyes_open`: hier ist Ausschluss richtig und das Gegenteil von 2. Ob ein
Unbekannter im Hintergrund blinzelt, sagt nichts über die Bildqualität —
niemand verwirft ein Familienfoto deswegen. Heute zieht genau das 0,20 des
Scores herunter.

Zum Zweig: statt hart umzuschalten werden beide Formeln berechnet und nach
prominenter Gesichtsabdeckung überblendet. Ein Foto mit einer winzigen
Person im Hintergrund behält damit seine Kompositionsbewertung
(`clip_composition`, `clip_technical`), statt sie zu verlieren.

## 5. Datenlage: was geht ohne Re-Scan, was nicht

Entscheidend für den Zuschnitt der Etappen:

| Daten | vorhanden? |
|---|---|
| bbox je Gesicht | **ja** (`faces.bbox`) |
| Personenzuordnung / ignoriert | **ja** (`user_face_assignments`) |
| Schärfe **je Gesicht** | **nein** — `ai_quality_details.face_sharpness` ist nur das Minimum |
| „Augen offen" **je Gesicht** | **nein** — ebenfalls nur das Minimum |

`faces.quality` existiert als Spalte, wird beim Insert aber konstant auf
`100` gesetzt und trägt keine Information.

Alles, was nur bbox und Zuordnung braucht — Zweig-Übergang,
`face_coverage`, Anwesenheit bekannter Personen — ist **ohne jeden Re-Scan**
machbar. Die Schärfe je Gesicht braucht einen Backfill, aber einen
**billigen**: die Laplace-Varianz über einen bbox-Ausschnitt ist reine
Pixelarithmetik, kein Modell-Inferenz. Kein CLIP, keine GPU. Kosten
entsprechen etwa einem Thumbnail-Lauf (Bild einmal dekodieren, N Ausschnitte
rechnen), und die Formel ist bereits in `frontend/src/utils/focusPeaking.ts`
implementiert und unit-getestet — sie müsste nur serverseitig mit `sharp`
gespiegelt werden.

Pro Gesicht „Augen offen" wäre dagegen echte CLIP-Inferenz je Ausschnitt —
deutlich teurer und vorerst zurückgestellt.

## 6. Etappen

**Etappe 0 — Messen, welches Signal den Δ erzeugt.** Kein Eingriff ins
Scoring. `ai_pick_details.scores` enthält je Foto die Signal-Aufschlüsselung;
daraus lässt sich pro Gruppe bestimmen, welcher Term den Abstand zwischen
Top-Pick und Runner-up tatsächlich aufmacht — aufgeschlüsselt nach
`high`/`medium`/`low`. Ohne diesen Befund ist jede Gewichtsänderung geraten.
Erwartung: `face_coverage`. Wird sie bestätigt, ist der Fix klein und
zielgenau.

**Etappe 1 — Prominenz aus bbox, ohne Re-Scan.** Relevanzgewicht,
gleitender Zweig-Übergang, `face_coverage` nur über prominente Gesichter,
Anwesenheit bekannter Personen als schwaches Signal. Vollständig offline
validierbar (siehe 7).

**Etappe 2 — Schärfe je Gesicht (billiger Backfill).** Neue Spalte
`faces.sharpness`, gefüllt durch einen Hintergrund-Job analog zum
Dimensions-Backfill. Erst damit wird das eigentliche Ziel möglich: „die
Aufnahme, auf der das Gesicht der bekannten Person scharf ist" — das
Kriterium, nach dem beim manuellen Aussortieren tatsächlich entschieden
wird. Nebeneffekt: Focus Peaking im Frontend könnte die Werte direkt lesen,
statt sie bei jedem Betrachten neu zu berechnen.

**Etappe 3 — „Augen offen" je Gesicht.** Nur, falls Etappe 0 zeigt, dass
`eyes_open` relevant zum Δ beiträgt. Teuer, daher zuletzt.

## 7. Validierung: Offline-Replay, bevor irgendetwas produktiv wird

Der wichtigste Punkt des Konzepts — und die Lehre aus der widerlegten
Ausgangshypothese: **keine Formeländerung ohne vorherige Messung am
historischen Datenbestand.**

Die reviewten Gruppen sind ein fertiges Testset: Gruppe, gespeicherte
Signale, tatsächliche Nutzerentscheidung. Damit lässt sich eine geänderte
Formel offline durchrechnen und gegen die heutige halten:

- Trefferquote gesamt, alt gegen neu
- Trefferquote je Konfidenz-Bucket (entscheidend: wird das Gate wieder
  prädiktiv?)
- Anzahl Gruppen, deren Pick sich ändert (Bewegungsmaß)

Für Etappe 1 ist das vollständig möglich, weil sich Prominenz und
Zweig-Übergang allein aus `faces.bbox` neu berechnen lassen — die übrigen
Signale liegen in `ai_pick_details`. Erst wenn der Replay eine Verbesserung
zeigt, wird die Formel scharf geschaltet.

Schwellwerte (`PROMINENCE_SATURATION`, Untergrenze, `KNOWN_BONUS`, γ) werden
**nicht geraten**, sondern über den Replay bestimmt. Aus dem Report ist
bereits absehbar, dass die Wahl folgenreich ist: eine Prominenzgrenze bei
2 % Bildfläche verschiebt 71,9 % der heutigen Face-Zweig-Fotos.

## 8. Sofortmaßnahme, unabhängig vom Umbau

Die 75,9 % im `high`-Bucket bedeuten: in rund einem Viertel der Fälle, in
denen ungefragt ausgeblendet wird, widerspricht der Nutzer später. Solange
das Gate nicht repariert ist, wäre zu erwägen,
`HIGH_CONFIDENCE_DELTA` anzuheben oder den Bulk-Accept vorübergehend hinter
eine Bestätigung je Gruppe zu legen. Das ist eine kleine, sofort wirksame
Änderung und hängt an keiner der Etappen — aber es ist eine
Produktentscheidung, keine technische.

## 9. Offene Punkte

- **Etappe 0 steht aus.** Ohne sie ist die Ursache des invertierten Gates
  nicht belegt, sondern nur plausibel.
- **Selektionseffekt** bei reviewten high-Gruppen (siehe 1a) — der Replay
  erbt ihn. Er verzerrt den Vergleich alt/neu aber nicht, solange beide auf
  demselben Testset laufen.
- **Bestehende Picks** ändern sich durch eine neue Formel. Das System rührt
  reviewte Gruppen nicht mehr an, betroffen sind also nur offene — trotzdem
  bewegt sich für den Nutzer sichtbar etwas.
- **Kalibrierung**: die per-Nutzer-Gewichte schlagen die Defaults kaum. Ob
  sich das mit besseren Signalen ändert oder ob der pairwise-Fit selbst das
  Problem ist, ist offen.
