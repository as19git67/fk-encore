# Nur die Info.plist wohnt hier

Der Ordner sieht aus, als läge hier die Share-Extension. Sie liegt aber in
**`ios/F4milShare/`** — das ist die `PBXFileSystemSynchronizedRootGroup` des
Targets `F4milShare`, also wird alles von dort gebaut. Hier liegt einzig die
`Info.plist`, weil das Build-Setting `INFOPLIST_FILE` des Targets auf
`App/ShareExtension/Info.plist` zeigt.

Bis September 2026 lag daneben eine zweite, ältere `ShareViewController.swift`
in keinem Target. Sie war 26 KB Code, der lebendig aussah und es nicht war:
Änderungen daran wirkten nirgends, und wer die Extension anpassen wollte,
erwischte mit einiger Wahrscheinlichkeit die falsche Datei. Dasselbe galt für
eine `ShareExtension.entitlements`, die eine *andere* App-Group deklarierte als
die tatsächlich signierte in `F4milShare/`.

**Also: Code nach `ios/F4milShare/`, `Info.plist` bleibt hier.**

## Was die Schlüssel der Info.plist bedeuten

Die Erklärungen stehen hier und nicht als XML-Kommentare in der Plist:
Xcode schreibt Property Lists beim Öffnen des Targets in seiner
kanonischen Form zurück — Schlüssel alphabetisch, ohne Kommentare —, und
jede Abweichung davon im Repo erzeugt nach jedem Build einen Diff, der
vor dem nächsten `git pull` erst zurückgesetzt werden muss.

- `CFBundleDevelopmentRegion = de`: Die App ist durchgehend deutsch, und
  ohne diese Angabe meldet das Bundle Englisch als einzige unterstützte
  Sprache. iOS wählt die Sprache der System-Oberflächen — Ausschneiden/
  Kopieren/Einfügen, Tastatur, Standardknöpfe, Foto-Picker, Share-Sheet —
  aus der Schnittmenge von Gerätesprache und den Sprachen der App: bei
  „nur Englisch" bleibt dieses Menü englisch, auch auf einem deutschen
  iPhone, mitten in deutschen Texten.
- `NSExtensionActivationSupportsWebURLWithMaxCount = 1`: Ein geteilter
  Link ist der klarste Weg, auf dem ein Fund die Urlaubsplanung erreicht —
  ein Karten-Pin oder ein Artikel über eine Stadt
  (`docs/ios-urlaubsplanung.md` §9.2, Fälle 1 und 2).
- `NSExtensionActivationSupportsText`: Markierter Text, und alles, was eine
  Chat-App als reinen Text statt als Link teilt.
- `NSExtensionActivationSupportsWebPageWithMaxCount = 1`: Lässt Safari das
  Vorverarbeitungs-Skript in der bereits geöffneten Seite laufen, damit
  deren sichtbarer Text mitkommt, ohne dass der Server etwas laden muss
  (§9.3 Stufe 1).
- `NSExtensionJavaScriptPreprocessingFile = TripSharePageReading`: Ohne
  `.js` — der Wert ist der Basisname, die Datei selbst ist eine Ressource
  des Targets `F4milShare` (`ios/F4milShare/TripSharePageReading.js`).
