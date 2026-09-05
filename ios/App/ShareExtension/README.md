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
